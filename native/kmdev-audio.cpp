// KM-DEV Stream - Anwendungsaudio (Ausbaustufe 3)
//
// Nimmt den Ton einzelner Programme auf (WASAPI "Process Loopback", ab
// Windows 10 Build 20348 / Windows 11), mischt ihn mit Lautstaerke pro App und
// gibt ihn als PCM an die App weiter. Die App selbst (und alles, was sie
// startet) wird nie aufgenommen - so gibt es kein Echo, wenn man streamt und
// gleichzeitig zuschaut.
//
// Steuerung ueber stdin, eine Zeile pro Befehl (Felder mit TAB getrennt):
//   list                                   -> Liste der Programme mit Ton
//   config <mode> <master> <auswahl> <lautstaerken>
//     mode: all | include | exclude (Alle / Ausgewaehlte / Alle ausser Ausgewaehlten)
//     auswahl: exe-Namen mit Komma getrennt, z. B. spotify.exe,chrome.exe
//     lautstaerken: exe=faktor mit Semikolon getrennt, z. B. spotify.exe=0.5
//   quit
//
// Ausgabe auf stdout in Rahmen: 1 Byte Typ, 4 Byte Laenge (LE), Daten.
//   'P' = 480 Frames Float32 Stereo 48 kHz (10 ms)
//   'J' = JSON (Programmliste, Status, Fehler)
//
// Aufruf: kmdev-audio.exe --exclude-tree <pid der App>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <tlhelp32.h>
#include <timeapi.h>
#include <wrl/implements.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "version.lib")
#pragma comment(lib, "winmm.lib")

using Microsoft::WRL::ComPtr;

static const int RATE = 48000;
static const int CHANNELS = 2;
static const int CHUNK = 480;           // 10 ms
static const int PRIME = RATE / 50;     // 20 ms Puffer bevor gemischt wird
static const int MAX_BUFFER = RATE / 5; // > 200 ms -> alte Daten verwerfen

/* ---------- Ausgabe ---------- */

static std::mutex g_outMutex;
static HANDLE g_stdout;

static void writeFrame(char type, const void* data, uint32_t len) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  char hdr[5];
  hdr[0] = type;
  memcpy(hdr + 1, &len, 4);
  DWORD n;
  WriteFile(g_stdout, hdr, 5, &n, nullptr);
  if (len) WriteFile(g_stdout, data, len, &n, nullptr);
}

static void writeJson(const std::string& s) { writeFrame('J', s.data(), (uint32_t)s.size()); }

static std::string utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

static std::string jsonStr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}

static std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)tolower(c); });
  return s;
}

/* ---------- Prozesse ---------- */

struct ProcInfo {
  std::string path;  // voller Pfad (UTF-8)
  std::string exe;   // Dateiname klein, z. B. "spotify.exe"
  std::string name;  // Anzeigename aus der Versionsinfo
};

static ProcInfo queryProcess(DWORD pid) {
  ProcInfo info;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return info;
  wchar_t buf[MAX_PATH * 2];
  DWORD size = (DWORD)std::size(buf);
  if (QueryFullProcessImageNameW(h, 0, buf, &size)) {
    std::wstring path(buf, size);
    info.path = utf8(path);
    size_t slash = path.find_last_of(L"\\/");
    std::wstring file = slash == std::wstring::npos ? path : path.substr(slash + 1);
    info.exe = lower(utf8(file));
    info.name = utf8(file.size() > 4 ? file.substr(0, file.size() - 4) : file);

    DWORD dummy;
    DWORD vsize = GetFileVersionInfoSizeW(path.c_str(), &dummy);
    if (vsize) {
      std::vector<BYTE> ver(vsize);
      if (GetFileVersionInfoW(path.c_str(), 0, vsize, ver.data())) {
        struct LangCp { WORD lang, cp; } *tr = nullptr;
        UINT trLen = 0;
        if (VerQueryValueW(ver.data(), L"\\VarFileInfo\\Translation", (void**)&tr, &trLen) && trLen >= sizeof(LangCp)) {
          wchar_t key[64];
          swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", tr[0].lang, tr[0].cp);
          wchar_t* desc = nullptr;
          UINT dlen = 0;
          if (VerQueryValueW(ver.data(), key, (void**)&desc, &dlen) && dlen > 1) info.name = utf8(std::wstring(desc, dlen - 1));
        }
      }
    }
  }
  CloseHandle(h);
  return info;
}

static std::map<DWORD, DWORD> parentMap() {
  std::map<DWORD, DWORD> m;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return m;
  PROCESSENTRY32W pe = { sizeof(pe) };
  if (Process32FirstW(snap, &pe)) {
    do { m[pe.th32ProcessID] = pe.th32ParentProcessID; } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  return m;
}

static bool isDescendant(DWORD pid, DWORD ancestor, const std::map<DWORD, DWORD>& parents) {
  for (int depth = 0; depth < 64 && pid; depth++) {
    if (pid == ancestor) return true;
    auto it = parents.find(pid);
    if (it == parents.end() || it->second == pid) return false;
    pid = it->second;
  }
  return false;
}

// Browser & Co. spielen Ton in einem (oft abgeschotteten) Unterprozess ab.
// Dessen Ton laesst sich zuverlaessig nur ueber den Hauptprozess samt
// Unterprozessen aufnehmen (so macht es auch OBS) -> obersten Vorfahren mit
// gleichem Programmnamen suchen.
static DWORD rootOfSameExe(DWORD pid, const std::string& exe, const std::map<DWORD, DWORD>& parents) {
  DWORD root = pid;
  for (int depth = 0; depth < 32; depth++) {
    auto it = parents.find(root);
    if (it == parents.end() || it->second == 0 || it->second == root) break;
    if (queryProcess(it->second).exe != exe) break;
    root = it->second;
  }
  return root;
}

/* ---------- Programme mit Audio-Sitzung ---------- */

struct Session {
  DWORD pid;
  bool active;
  float peak; // aktueller Pegel laut Windows (0..1)
  bool onDefault = false; // Sitzung laeuft auf dem Standard-Wiedergabegeraet
};

// Alle Wiedergabegeraete, nicht nur das Standardgeraet (Headset + Lautsprecher).
static std::vector<Session> listSessions() {
  std::map<DWORD, Session> found;
  ComPtr<IMMDeviceEnumerator> en;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) return {};
  ComPtr<IMMDeviceCollection> devices;
  if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) return {};
  UINT count = 0;
  devices->GetCount(&count);
  std::wstring defaultId;
  {
    ComPtr<IMMDevice> def;
    LPWSTR id = nullptr;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &def)) && SUCCEEDED(def->GetId(&id))) { defaultId = id; CoTaskMemFree(id); }
  }
  for (UINT d = 0; d < count; d++) {
    ComPtr<IMMDevice> dev;
    ComPtr<IAudioSessionManager2> mgr;
    ComPtr<IAudioSessionEnumerator> sessions;
    if (FAILED(devices->Item(d, &dev))) continue;
    bool isDefault = false;
    { LPWSTR id = nullptr; if (SUCCEEDED(dev->GetId(&id))) { isDefault = defaultId == id; CoTaskMemFree(id); } }
    if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) continue;
    if (FAILED(mgr->GetSessionEnumerator(&sessions))) continue;
    int n = 0;
    sessions->GetCount(&n);
    for (int i = 0; i < n; i++) {
      ComPtr<IAudioSessionControl> ctl;
      ComPtr<IAudioSessionControl2> ctl2;
      if (FAILED(sessions->GetSession(i, &ctl)) || FAILED(ctl.As(&ctl2))) continue;
      if (ctl2->IsSystemSoundsSession() == S_OK) continue;
      AudioSessionState state;
      if (FAILED(ctl2->GetState(&state)) || state == AudioSessionStateExpired) continue;
      DWORD pid = 0;
      if (FAILED(ctl2->GetProcessId(&pid)) || pid == 0) continue;
      float peak = 0;
      ComPtr<IAudioMeterInformation> meter;
      if (SUCCEEDED(ctl.As(&meter))) meter->GetPeakValue(&peak);
      auto& f = found[pid];
      f.pid = pid;
      f.active = f.active || state == AudioSessionStateActive;
      f.peak = std::max(f.peak, peak);
      f.onDefault = f.onDefault || isDefault;
    }
  }
  std::vector<Session> out;
  for (auto& kv : found) out.push_back(kv.second);
  return out;
}

/* ---------- Aufnahme eines Prozesses ---------- */

class ActivationHandler : public Microsoft::WRL::RuntimeClass<
  Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Microsoft::WRL::FtmBase,
  IActivateAudioInterfaceCompletionHandler> {
public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;
  ~ActivationHandler() { CloseHandle(done); }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    ComPtr<IUnknown> unk;
    HRESULT hr = E_FAIL;
    if (SUCCEEDED(op->GetActivateResult(&hr, &unk)) && SUCCEEDED(hr)) hr = unk.As(&client);
    result = hr;
    SetEvent(done);
    return S_OK;
  }
};

struct Capture {
  DWORD pid;
  std::string exe;
  bool excludeTree = false; // true: alles AUSSER pid samt Unterprozessen
  std::atomic<bool> stop{ false };
  std::atomic<bool> failed{ false };
  std::thread thread;
  std::mutex mutex;
  std::vector<float> buffer; // Stereo, interleaved
  bool primed = false;

  void run() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (!capture()) failed = true;
    CoUninitialize();
  }

  bool capture() {
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = excludeTree
      ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
      : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = (BYTE*)&params;

    auto handler = Microsoft::WRL::Make<ActivationHandler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> op;
    if (FAILED(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op))) return false;
    if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0 || FAILED(handler->result)) return false;
    ComPtr<IAudioClient> client = handler->client;

    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = CHANNELS;
    fmt.nSamplesPerSec = RATE;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = CHANNELS * 4;
    fmt.nAvgBytesPerSec = RATE * fmt.nBlockAlign;
    HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      200000, 0, &fmt, nullptr);
    if (FAILED(hr)) return false;
    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    ComPtr<IAudioCaptureClient> cap;
    if (FAILED(client->SetEventHandle(ev)) || FAILED(client->GetService(IID_PPV_ARGS(&cap))) || FAILED(client->Start())) {
      CloseHandle(ev);
      return false;
    }
    while (!stop) {
      if (WaitForSingleObject(ev, 100) != WAIT_OBJECT_0) continue;
      UINT32 packet = 0;
      while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
        BYTE* data;
        UINT32 frames;
        DWORD flags;
        if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
        {
          std::lock_guard<std::mutex> lock(mutex);
          size_t at = buffer.size();
          buffer.resize(at + (size_t)frames * CHANNELS);
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) std::fill(buffer.begin() + at, buffer.end(), 0.0f);
          else memcpy(&buffer[at], data, (size_t)frames * CHANNELS * 4);
          // Zu viel angestaut (z. B. Mischer haengt) -> Aelteres verwerfen.
          if (buffer.size() > (size_t)MAX_BUFFER * CHANNELS) {
            buffer.erase(buffer.begin(), buffer.end() - (size_t)PRIME * CHANNELS);
          }
        }
        cap->ReleaseBuffer(frames);
      }
    }
    client->Stop();
    CloseHandle(ev);
    return true;
  }

  // Holt CHUNK Frames (oder Stille, solange zu wenig gepuffert ist).
  bool take(float* out) {
    std::lock_guard<std::mutex> lock(mutex);
    size_t frames = buffer.size() / CHANNELS;
    if (!primed && frames >= PRIME) primed = true;
    if (!primed) return false;
    if (frames < CHUNK) { primed = false; return false; }
    memcpy(out, buffer.data(), CHUNK * CHANNELS * 4);
    buffer.erase(buffer.begin(), buffer.begin() + CHUNK * CHANNELS);
    return true;
  }
};

/* ---------- Steuerung ---------- */

static std::mutex g_cfgMutex;
static std::string g_mode = "all";
static float g_master = 1.0f;
static std::set<std::string> g_selected;      // exe-Namen der Auswahl
static std::map<std::string, float> g_volumes; // exe -> Lautstaerke
static std::atomic<bool> g_running{ true };
static std::atomic<bool> g_listRequested{ true };
static DWORD g_excludeTree = 0;

static std::map<DWORD, std::unique_ptr<Capture>> g_captures;
static std::mutex g_capMutex;

static void stopCapture(std::unique_ptr<Capture>& c) {
  c->stop = true;
  if (c->thread.joinable()) c->thread.join();
}

static void readCommands() {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::string line;
  char ch;
  DWORD n;
  while (g_running && ReadFile(in, &ch, 1, &n, nullptr) && n == 1) {
    if (ch == '\r') continue;
    if (ch != '\n') { line += ch; continue; }
    std::vector<std::string> f;
    size_t start = 0;
    for (;;) {
      size_t tab = line.find('\t', start);
      f.push_back(line.substr(start, tab == std::string::npos ? std::string::npos : tab - start));
      if (tab == std::string::npos) break;
      start = tab + 1;
    }
    if (f[0] == "quit") break;
    if (f[0] == "list") g_listRequested = true;
    if (f[0] == "config" && f.size() >= 3) {
      std::lock_guard<std::mutex> lock(g_cfgMutex);
      g_mode = f[1];
      g_master = (float)atof(f[2].c_str());
      g_selected.clear();
      g_volumes.clear();
      auto split = [](const std::string& s, char sep) {
        std::vector<std::string> out;
        size_t a = 0;
        while (a <= s.size()) {
          size_t b = s.find(sep, a);
          if (b == std::string::npos) b = s.size();
          if (b > a) out.push_back(s.substr(a, b - a));
          a = b + 1;
        }
        return out;
      };
      if (f.size() > 3) for (auto& e : split(f[3], ',')) g_selected.insert(lower(e));
      if (f.size() > 4) for (auto& e : split(f[4], ';')) {
        size_t eq = e.rfind('=');
        if (eq != std::string::npos) g_volumes[lower(e.substr(0, eq))] = (float)atof(e.c_str() + eq + 1);
      }
    }
    line.clear();
  }
  g_running = false; // stdin zu = App beendet
}

// Gleicht die laufenden Aufnahmen mit den Programmen und der Auswahl ab.
static void reconcile() {
  auto sessions = listSessions();
  auto parents = parentMap();
  std::string mode;
  std::set<std::string> selectedSet;
  bool customVolumes = false;
  {
    std::lock_guard<std::mutex> lock(g_cfgMutex);
    mode = g_mode;
    selectedSet = g_selected;
    for (auto& kv : g_volumes) if (std::fabs(kv.second - 1.0f) > 0.001f) customVolumes = true;
  }
  // "Alle Apps" ohne eigene Lautstaerken: eine einzige Aufnahme "alles ausser
  // der KM-DEV-Stream-App". Robuster als viele Einzelaufnahmen (manche
  // abgeschottete Prozesse liefern dort nur Stille).
  const bool wholeSystem = mode == "all" && !customVolumes;
  const DWORD WHOLE = 0; // Schluessel der Ausschluss-Aufnahme in g_captures

  std::map<DWORD, ProcInfo> infos;
  std::set<DWORD> wanted;
  struct Listed { ProcInfo info; bool active = false; bool onDefault = false; float peak = 0; std::vector<DWORD> pids; };
  std::map<std::string, Listed> listed; // pro Programm ein Eintrag (Browser haben mehrere Prozesse)
  for (auto& s : sessions) {
    if (s.pid == GetCurrentProcessId()) continue; // eigene Aufnahme-Sitzungen
    if (g_excludeTree && isDescendant(s.pid, g_excludeTree, parents)) continue;
    ProcInfo info = queryProcess(s.pid);
    if (info.exe.empty()) continue;
    infos[s.pid] = info;
    bool selected = selectedSet.count(info.exe) > 0;
    bool want = mode == "include" ? selected : (mode == "exclude" ? !selected : true);
    if (want && !wholeSystem) {
      DWORD root = rootOfSameExe(s.pid, info.exe, parents);
      if (!infos.count(root)) infos[root] = info;
      wanted.insert(root);
    }
    auto& l = listed[info.exe];
    if (l.pids.empty()) l.info = info;
    l.active = l.active || s.active;
    l.peak = std::max(l.peak, s.peak);
    l.onDefault = l.onDefault || s.onDefault;
    l.pids.push_back(s.pid);
  }
  std::string json = "{\"type\":\"apps\",\"apps\":[";
  bool first = true;
  for (auto& kv : listed) {
    auto& l = kv.second;
    std::string pids;
    for (DWORD p : l.pids) pids += (pids.empty() ? "" : ",") + std::to_string(p);
    json += std::string(first ? "" : ",") + "{\"exe\":" + jsonStr(l.info.exe) + ",\"name\":" + jsonStr(l.info.name) +
      ",\"path\":" + jsonStr(l.info.path) + ",\"active\":" + (l.active ? "true" : "false") + ",\"onDefault\":" + (l.onDefault ? "true" : "false") +
      ",\"peak\":" + std::to_string(std::round(l.peak * 100) / 100) + ",\"pids\":[" + pids + "]}";
    first = false;
  }
  json += "]";

  // Ist ein Vorfahre schon dabei, nimmt dessen Aufnahme (inkl. Unterprozesse)
  // den Ton bereits mit -> sonst doppelt.
  std::set<DWORD> final;
  if (wholeSystem) final.insert(WHOLE);
  for (DWORD pid : wanted) {
    bool covered = false;
    for (DWORD other : wanted) {
      if (other != pid && isDescendant(pid, other, parents)) { covered = true; break; }
    }
    if (!covered) final.insert(pid);
  }

  // Zur Fehlersuche: welche Prozesse gerade aufgenommen werden.
  json += ",\"capturing\":[";
  bool firstPid = true;
  for (DWORD pid : final) { if (pid == WHOLE) { json += std::string(firstPid ? "" : ",") + "{\"pid\":0,\"exe\":\"*\"}"; firstPid = false; continue; } json += std::string(firstPid ? "" : ",") + "{\"pid\":" + std::to_string(pid) + ",\"exe\":" + jsonStr(infos[pid].exe) + "}"; firstPid = false; }
  json += "]}";

  {
    std::lock_guard<std::mutex> lock(g_capMutex);
    for (auto it = g_captures.begin(); it != g_captures.end();) {
      if (!final.count(it->first) || it->second->failed) {
        stopCapture(it->second);
        it = g_captures.erase(it);
      } else {
        ++it;
      }
    }
    for (DWORD pid : final) {
      if (g_captures.count(pid)) continue;
      auto c = std::make_unique<Capture>();
      if (pid == WHOLE) {
        c->pid = g_excludeTree ? g_excludeTree : GetCurrentProcessId();
        c->excludeTree = true;
      } else {
        c->pid = pid;
        c->exe = infos[pid].exe;
      }
      Capture* raw = c.get();
      c->thread = std::thread([raw] { raw->run(); });
      g_captures[pid] = std::move(c);
    }
  }

  static std::string lastJson;
  if (g_listRequested.exchange(false) || json != lastJson) {
    lastJson = json;
    writeJson(json);
  }
}

// Mischt alle 10 ms die Aufnahmen und schickt das Ergebnis an die App.
static void mixLoop() {
  timeBeginPeriod(1);
  LARGE_INTEGER freq, start, now;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&start);
  long long emitted = 0;
  std::vector<float> mix(CHUNK * CHANNELS), tmp(CHUNK * CHANNELS);
  while (g_running) {
    QueryPerformanceCounter(&now);
    long long due = (now.QuadPart - start.QuadPart) * RATE / freq.QuadPart;
    if (due - emitted > RATE) emitted = due - CHUNK; // nach Haenger nicht nachholen
    if (due - emitted < CHUNK) { Sleep(2); continue; }

    std::fill(mix.begin(), mix.end(), 0.0f);
    bool any = false;
    float master;
    std::map<std::string, float> volumes;
    {
      std::lock_guard<std::mutex> lock(g_cfgMutex);
      master = g_master;
      volumes = g_volumes;
    }
    {
      std::lock_guard<std::mutex> lock(g_capMutex);
      for (auto& kv : g_captures) {
        if (!kv.second->take(tmp.data())) continue;
        auto it = volumes.find(kv.second->exe);
        float vol = it != volumes.end() ? it->second : 1.0f;
        for (int i = 0; i < CHUNK * CHANNELS; i++) mix[i] += tmp[i] * vol;
        any = true;
      }
    }
    emitted += CHUNK;
    if (!any) continue; // Stille nicht uebertragen, die App fuellt selbst auf
    for (auto& s : mix) s = std::max(-1.0f, std::min(1.0f, s * master));
    writeFrame('P', mix.data(), (uint32_t)(mix.size() * 4));
  }
  timeEndPeriod(1);
}

static bool processLoopbackSupported() {
  // Process Loopback gibt es ab Windows 10 Build 20348.
  typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
  auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  RTL_OSVERSIONINFOW v = { sizeof(v) };
  if (!fn || fn(&v) != 0) return false;
  return v.dwMajorVersion > 10 || (v.dwMajorVersion == 10 && v.dwBuildNumber >= 20348);
}

int wmain(int argc, wchar_t** argv) {
  g_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
  for (int i = 1; i + 1 < argc; i++) {
    if (wcscmp(argv[i], L"--exclude-tree") == 0) g_excludeTree = (DWORD)_wtoi(argv[i + 1]);
  }
  if (!processLoopbackSupported()) {
    writeJson("{\"type\":\"unsupported\",\"message\":\"Anwendungsaudio braucht Windows 11 oder Windows 10 ab Build 20348.\"}");
    return 2;
  }
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  writeJson("{\"type\":\"ready\"}");

  std::thread cmd(readCommands);
  cmd.detach(); // blockiert in ReadFile; endet mit dem Prozess
  std::thread mixer(mixLoop);
  while (g_running) {
    reconcile();
    for (int i = 0; i < 10 && g_running && !g_listRequested; i++) Sleep(100);
  }
  mixer.join();
  {
    std::lock_guard<std::mutex> lock(g_capMutex);
    for (auto& kv : g_captures) stopCapture(kv.second);
    g_captures.clear();
  }
  CoUninitialize();
  return 0;
}

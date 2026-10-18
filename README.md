# KMDev Stream

Bildschirm-/Fensterübertragung per WebRTC (P2P) als installierbare Windows-App
mit Auto-Update über GitHub Releases. Die Einstellungen sind an TeamSpeak 6 angelehnt.

**Download:** [Releases](https://github.com/KMDEV-Marcel/kmdev_app_streamer/releases/latest) → `KMDev-Stream-Setup-<version>.exe`

## Ausbaustufen

| Stufe | Inhalt | Stand |
|---|---|---|
| 1 | Grundgerüst: Aufnahme Bildschirm/Fenster, P2P über Signaling-Server, alle Video-Einstellungen, Auto-Update | ✅ |
| 2 | Server-Modus (LiveKit-SFU), Browser-Link für Zuschauer, TURN | offen |
| 3 | Anwendungsaudio pro App (WASAPI Process Loopback): Ausgewählte / Alle außer / Alle, Regler pro App | offen |
| 4 | Code-Signing, Feinschliff Installer | offen |

## Architektur

```
  Host-App ──(WSS: SDP/ICE)──► Cloudflare ──► Caddy ──► Signaling-Server ◄── … ── Zuschauer-App
     │                                                   (Node, 127.0.0.1)
     └───────────── WebRTC P2P (Bild + Ton, DTLS-SRTP verschlüsselt) ──────────────────┘

  Auto-Update:  App ──► GitHub Releases dieses Repos (latest.yml + Setup-EXE)
```

- **P2P = Mesh**: Der Host schickt jedem Zuschauer einen eigenen Stream.
  Upload ≈ Bitrate × Zuschauer. Die App zeigt den geschätzten Upload an.
- **Server-Adresse**: Im Code ist keine Domain hinterlegt. Jeder trägt beim
  ersten Start unter ⚙ seinen eigenen Server ein. Die Kurzform
  `stream.meinedomain.de` reicht, daraus wird `wss://stream.meinedomain.de/ws`.

## Ordner

| Pfad | Zweck |
|---|---|
| `main.js`, `preload.js` | Electron-Hauptprozess: Fenster, Quellen-Auswahl, Einstellungen |
| `updater.js` | Auto-Update (electron-updater, GitHub provider) |
| `renderer/` | Oberfläche (`app.js`), WebRTC (`rtc.js`), Presets (`presets.js`) |
| `server/` | Signaling-Server (Node), Caddy-Vorlage, Setup-Skript für Windows Server |
| `.github/workflows/release.yml` | Baut bei einem Tag `v*` den Installer und veröffentlicht das Release |

## Entwicklung

```powershell
# Server lokal
cd server
npm install
npm start                      # http://127.0.0.1:8443, WS unter /ws

# App
npm install
npm start
```

In der App unter ⚙ als Server `ws://127.0.0.1:8443/ws` eintragen. Eine zweite
Instanz zum Testen startest du mit eigenem Profil:

```powershell
npx electron . --user-data-dir="$env:TEMP\kmdev-stream-2"
```

## Updates veröffentlichen

1. In `package.json` die `version` erhöhen (z. B. `0.1.0` → `0.2.0`) und committen.
2. Tag setzen und pushen:
   ```powershell
   git tag v0.2.0
   git push origin main --tags
   ```
3. GitHub Actions baut den Installer und legt das Release mit `latest.yml`, EXE
   und Blockmap an.

Die Apps prüfen beim Start und alle 4 Stunden auf Updates. Ein Update wird im
Hintergrund geladen und dann per Banner („Jetzt neu starten“) angeboten.
Während eines laufenden Streams wird nicht neu gestartet. Spätestens beim
nächsten Beenden wird installiert.

> **Code-Signing:** Ohne Zertifikat zeigt Windows SmartScreen beim ersten
> Installieren eine Warnung („Weitere Informationen → Trotzdem ausführen“).
> Auto-Updates funktionieren trotzdem.

## Server einrichten (Windows Server + Cloudflare)

Im Repo liegen nur Vorlagen. `config.json`, `Caddyfile` und die Zertifikate
bleiben lokal auf dem Server (`.gitignore`).

### Cloudflare

1. **DNS**: `A`-Record für die Subdomain auf die Server-IP setzen, mit **Proxy an** (orange Wolke).
2. **SSL/TLS → Übersicht**: Modus **Full (strict)**.
3. **SSL/TLS → Origin Server → Create Certificate**: RSA, Hostname = die
   Subdomain, Gültigkeit 15 Jahre. Zertifikat als `server\certs\origin.pem`
   und Schlüssel als `server\certs\origin.key` speichern.
4. **Netzwerk**: WebSockets eingeschaltet lassen (Standard).
5. Optional: Unter Sicherheit eine WAF-/Bot-Regel für die Subdomain prüfen,
   damit die App-Verbindungen (kein Browser) nicht von einer Challenge geblockt werden.

Durch Cloudflare läuft nur das Signaling. Die Video- und Tondaten gehen P2P
direkt zwischen den Teilnehmern. Ein späterer TURN- bzw. LiveKit-Server (Stufe 2)
braucht UDP und einen **eigenen DNS-Eintrag ohne Proxy** (graue Wolke).

### Windows Server

1. **Node.js LTS**, **NSSM** (https://nssm.cc) und **Caddy** (https://caddyserver.com) installieren.
2. Den Ordner `server` auf den Server kopieren, z. B. nach `C:\kmdev-stream\server`.
3. Als Administrator ausführen:
   ```powershell
   cd C:\kmdev-stream\server
   .\install-server.ps1     # erster Lauf: legt config.json + Caddyfile an -> Domain/Pfade anpassen
   .\install-server.ps1     # zweiter Lauf: Dienste + Firewall
   ```
4. Test: `https://<subdomain>/health` → `{"ok":true,...}`

Dienste: `KMDevStream` (Node, nur 127.0.0.1:8443) und `KMDevStreamCaddy`
(HTTPS 443 mit dem Cloudflare-Origin-Zertifikat). Logs liegen unter `server\logs\`.

### TURN (optional, für Zuschauer hinter strengem NAT)

Der Server gibt zeitlich begrenzte TURN-Zugangsdaten aus (`config.json → turn`,
Schema „TURN REST API“ / `use-auth-secret`). Bis Stufe 2 klappen Verbindungen
in den meisten Netzen direkt. Schlägt eine fehl, zeigt die Zuschauer-App
„Verbindung fehlgeschlagen (evtl. Firewall/NAT – TURN nötig)“.

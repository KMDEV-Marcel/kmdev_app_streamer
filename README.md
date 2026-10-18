# KM-DEV Stream

Bildschirm-/Fensterübertragung per WebRTC (P2P) als installierbare Windows-App
mit Auto-Update über GitHub Releases. Die Einstellungen sind an TeamSpeak 6 angelehnt.

**Download:** [Releases](https://github.com/KMDEV-Marcel/kmdev_app_streamer/releases/latest) → `KM-DEV-Stream-Setup-<version>.exe`

## Ausbaustufen

| Stufe | Inhalt | Stand |
|---|---|---|
| 1 | Grundgerüst: Aufnahme Bildschirm/Fenster, P2P über Signaling-Server, alle Video-Einstellungen, Auto-Update | ✅ |
| 1b | Eigener TURN-Server auf dem Windows-Server | ✅ |
| 2 | Server-Modus (SFU), Browser-Link für Zuschauer, Zugangsschlüssel und Einladungen | ✅ |
| 3 | Anwendungsaudio pro App (WASAPI Process Loopback): Ausgewählte / Alle außer / Alle, Regler pro App | offen |
| 4 | Code-Signing, Feinschliff Installer | offen |

## Architektur

```
  Host-App ──(WSS: SDP/ICE)──► Cloudflare ──► Caddy ──► Signaling-Server ◄── … ── Zuschauer (App/Browser)
     │                                                   (Node, 127.0.0.1)
     │                                                        │ /media (lokal)
     │                                                   Medien-Server (kmdev-media.exe)
     │                                                     TURN + SFU, direkt auf der öffentlichen IP
     ├── P2P-Modus:    WebRTC direkt zu jedem Zuschauer (bei Bedarf über TURN)
     └── Server-Modus: WebRTC einmal zur SFU, die verteilt an alle Zuschauer

  Auto-Update:  App ──► GitHub Releases dieses Repos (latest.yml + Setup-EXE)
```

- **P2P-Modus (Mesh)**: Der Host schickt jedem Zuschauer einen eigenen Stream.
  Upload ≈ Bitrate × Zuschauer. Die App zeigt den geschätzten Upload an.
- **Server-Modus (SFU)**: Der Host lädt einmal hoch, der Server leitet die
  Pakete unverändert an alle Zuschauer weiter (kein Umkodieren, wenig CPU).
  Der Modus bleibt in der App gespeichert und gilt ab dem nächsten Streamstart.
- **Zuschauen im Browser**: „Link kopieren“ liefert `https://<domain>/watch#CODE`.
  Die Seite spielt den Stream im Browser ab oder öffnet ihn in der App.
- **Server-Adresse und Zugangsschlüssel**: Im Code ist keine Domain hinterlegt.
  Wer streamen oder die Stream-Liste sehen will, braucht den Zugangsschlüssel
  (`accessKey` in `config.json`). Am einfachsten über eine **Einladung**
  (`kmdev-stream://setup/…`): Das Install-Skript gibt sie am Ende aus, in der
  App gibt es unter ⚙ „Einladung kopieren“. Zum Zuschauen reicht der
  Stream-Code bzw. der Link, ohne Schlüssel. Falsche Codes/Passwörter werden
  nach 20 Fehlversuchen pro Adresse für 10 Minuten gesperrt.

  Eine Einladung ist **nicht verschlüsselt**, sondern nur kodiert. Die Domain
  kennt jeder, der eingeladen ist. Die öffentliche IP des Servers sehen
  Teilnehmer, die über TURN oder im Server-Modus verbinden. Schutz vor Fremden
  bietet der Zugangsschlüssel, nicht das Verstecken der Adresse.

## Ordner

| Pfad | Zweck |
|---|---|
| `main.js`, `preload.js` | Electron-Hauptprozess: Fenster, Quellen-Auswahl, Einstellungen |
| `updater.js` | Auto-Update (electron-updater, GitHub provider) |
| `renderer/` | Oberfläche (`app.js`), WebRTC (`rtc.js`), Einladungen/Links (`invite.js`), Presets (`presets.js`) |
| `server/` | Signaling-Server (Node), Browser-Seite (`web/`), Caddy-Vorlage, Setup-Skript für Windows Server |
| `media/` | Medien-Server (Go/pion): TURN und Server-Modus (SFU), wird im Release-Workflow gebaut |
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

In der App unter ⚙ → „Server manuell eintragen“ als Server
`ws://127.0.0.1:8443/ws` eintragen. Ohne `accessKey` in `config.json` ist der
lokale Server offen. Für den Server-Modus zusätzlich `turn.publicIp` (z. B. die
LAN-IP) und `sfu.enabled`/`sfu.secret` setzen und den Medien-Server starten:

```powershell
cd media
go build -o kmdev-media.exe .
.\kmdev-media.exe -config ..\server\config.json
```

Eine zweite Instanz zum Testen startest du mit eigenem Profil:

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

Durch Cloudflare laufen nur Signaling und die Browser-Seite. Video und Ton
gehen P2P direkt zwischen den Teilnehmern oder über den Medien-Server (TURN,
Server-Modus). Der läuft direkt auf der öffentlichen IP, weil Cloudflare kein
WebRTC-UDP weiterleitet. Die Apps bekommen die IP vom Signaling-Server, einen
eigenen DNS-Eintrag braucht es dafür nicht.

### Windows Server

1. **Node.js LTS** installieren (https://nodejs.org, .msi). Mehr musst du nicht installieren.
2. Den Ordner `server` auf eine lokale Platte des Servers kopieren (kein Netzlaufwerk).
   Die beiden Origin-Dateien kommen nach `server\certs\`.
3. Eine PowerShell als Administrator öffnen:
   ```powershell
   cd <pfad>\server
   .\install-server.ps1     # erster Lauf: legt config.json + Caddyfile an -> im Caddyfile die Domain eintragen
   .\install-server.ps1     # zweiter Lauf: Downloads, Dienste, Firewall, Selbsttest
   ```
4. Test: `https://<subdomain>/health` → `{"ok":true,...,"sfu":true}`
5. Die am Ende ausgegebene **Einladung** (`kmdev-stream://setup/…`) in der App
   unter ⚙ → „Einladung einfügen“ eintragen und an alle weitergeben, die
   streamen sollen.

Das Skript lädt **WinSW** (Dienst-Wrapper, v2.12.0, SHA256-geprüft) und das
aktuelle **Caddy** von GitHub (gegen die offizielle checksums.txt geprüft)
nach `server\bin\`. Es prüft das Caddyfile, bevor es die Dienste einrichtet.

Dienste: `KMDevStream` (Node, nur 127.0.0.1:8443), `KMDevStreamCaddy`
(HTTPS 443 mit dem Cloudflare-Origin-Zertifikat) und `KMDevStreamMedia`
(TURN + Server-Modus). Alle starten automatisch und werden bei einem Absturz
neu gestartet. Logs mit Rotation liegen unter
`server\logs\` (`*.out.log`, `*.err.log`, `*.wrapper.log`).

**Port 443 schon belegt (z. B. IIS/Plesk)?** Dann erkennt das Skript das und
lässt Caddy auf einem alternativen HTTPS-Port laufen, den Cloudflare
unterstützt (2053, 2083, 2087 oder 2096). Das Skript nennt den gewählten Port
am Ende. Dazu brauchst du in Cloudflare eine **Origin Rule**:
*Regeln → Origin Rules → Regel erstellen → Hostname ist gleich `<subdomain>`
→ Zielport umschreiben auf `<Port>`*. Die Clients nutzen weiterhin 443.

Am Ende testet das Skript den Signaling-Server und Caddy lokal (HTTPS mit
SNI, so wie Cloudflare den Server anspricht).

Das Skript kann jederzeit erneut laufen, zum Beispiel nach einem `git pull`.
Es richtet die Dienste dann neu ein. Mit `-UpdateCaddy` holt es zusätzlich
die neueste Caddy-Version.

### Medien-Server: TURN und Server-Modus

Ein Programm (`media/`, Go auf Basis von [pion](https://github.com/pion))
mit zwei Aufgaben. GitHub Actions baut daraus `kmdev-media.exe` und hängt sie
an jedes Release, `install-server.ps1` lädt sie von dort und prüft die SHA256.
Bis v0.1.x hieß sie `kmdev-turn.exe` (Dienst `KMDevStreamTurn`); das Skript
räumt den alten Dienst beim nächsten Lauf weg.

**TURN** (Relay für Teilnehmer hinter NAT/Firewall): Klappt zwischen zwei
Teilnehmern keine direkte Verbindung (strenges NAT, Firmen-Firewall,
Mobilfunk), läuft der Verkehr über den eigenen Server. Bild und Ton bleiben
dabei Ende-zu-Ende verschlüsselt.

- Der Signaling-Server gibt pro Verbindung zeitlich begrenzte Zugangsdaten aus
  (Schema „TURN REST API“, gemeinsames `turn.secret`).
- TURN leitet nur an öffentliche Adressen weiter, nicht ins interne Netz und
  nicht an localhost.
- Ports: TCP+UDP 3478 und der UDP-Relay-Bereich (Standard 49160–49260).

**Server-Modus (SFU)**: Der Host schickt seinen Stream einmal an den Server,
der ihn an alle Zuschauer verteilt. Der Server entschlüsselt die Verbindung
dabei (DTLS-SRTP endet an der SFU), kodiert aber nicht um.

- Die SFU verbindet sich lokal mit dem Signaling-Server (`ws://127.0.0.1:<port>/media`,
  geschützt über `sfu.secret` und nur von localhost ohne Proxy-Header
  erreichbar) und tritt dort als Teilnehmer `sfu` auf.
- Alle Verbindungen teilen sich einen Port: UDP+TCP 3479 (`sfu.udpPort`).
- Keyframes: Bei neuen Zuschauern oder Paketverlust fordert die SFU beim Host
  ein neues Vollbild an.

**Einrichtung:** automatisch über `install-server.ps1`. Das Skript erzeugt
Secrets und Zugangsschlüssel, ermittelt die öffentliche IP, wählt Ports
außerhalb der von Windows reservierten Bereiche und legt Dienst und
Firewall-Regeln an. Mit `-NoTurn` bzw. `-NoSfu` lässt du einen Teil weg.

**Netzwerk:** TURN und SFU laufen direkt auf der öffentlichen IP und **nicht**
über Cloudflare, weil sie UDP brauchen. Hat dein Hoster eine eigene Firewall,
müssen die Ports auch dort offen sein (das Skript listet sie am Ende auf).

**Bandbreite:** Im Server-Modus geht der Stream einmal rein und pro Zuschauer
einmal raus. 6 Zuschauer mit 8 Mbit/s sind rund 56 Mbit/s, für eine
Gigabit-Leitung kein Problem. Über TURN läuft weitergeleiteter Verkehr
ebenfalls rein und raus.

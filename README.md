# KM-DEV Stream

Bildschirm-/Fensterübertragung per WebRTC (P2P) als installierbare Windows-App
mit Auto-Update über GitHub Releases. Die Einstellungen sind an TeamSpeak 6 angelehnt.

**Download:** [Releases](https://github.com/KMDEV-Marcel/kmdev_app_streamer/releases/latest) → `KM-DEV-Stream-Setup-<version>.exe`

## Ausbaustufen

| Stufe | Inhalt | Stand |
|---|---|---|
| 1 | Grundgerüst: Aufnahme Bildschirm/Fenster, P2P über Signaling-Server, alle Video-Einstellungen, Auto-Update | ✅ |
| 1b | Eigener TURN-Server auf dem Windows-Server | ✅ |
| 2 | Server-Modus (SFU), Browser-Link für Zuschauer | offen |
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
| `turn/` | TURN-Server (Go/pion) für Verbindungen hinter NAT, wird im Release-Workflow gebaut |
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

1. **Node.js LTS** installieren (https://nodejs.org, .msi). Mehr musst du nicht installieren.
2. Den Ordner `server` auf eine lokale Platte des Servers kopieren (kein Netzlaufwerk).
   Die beiden Origin-Dateien kommen nach `server\certs\`.
3. Eine PowerShell als Administrator öffnen:
   ```powershell
   cd <pfad>\server
   .\install-server.ps1     # erster Lauf: legt config.json + Caddyfile an -> im Caddyfile die Domain eintragen
   .\install-server.ps1     # zweiter Lauf: Downloads, Dienste, Firewall, Selbsttest
   ```
4. Test: `https://<subdomain>/health` → `{"ok":true,...}`

Das Skript lädt **WinSW** (Dienst-Wrapper, v2.12.0, SHA256-geprüft) und das
aktuelle **Caddy** von GitHub (gegen die offizielle checksums.txt geprüft)
nach `server\bin\`. Es prüft das Caddyfile, bevor es die Dienste einrichtet.

Dienste: `KMDevStream` (Node, nur 127.0.0.1:8443) und `KMDevStreamCaddy`
(HTTPS 443 mit dem Cloudflare-Origin-Zertifikat). Beide starten automatisch
und werden bei einem Absturz neu gestartet. Logs mit Rotation liegen unter
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

### TURN-Server (Relay für Teilnehmer hinter NAT/Firewall)

Klappt zwischen zwei Teilnehmern keine direkte Verbindung (strenges NAT,
Firmen-Firewall, Mobilfunk), läuft der Verkehr über den eigenen TURN-Server
auf dem Dedicated Server. Bild und Ton bleiben dabei Ende-zu-Ende verschlüsselt.

- **Programm:** `turn/` (Go, auf Basis von [pion/turn](https://github.com/pion/turn)).
  GitHub Actions baut daraus `kmdev-turn.exe` und hängt sie an jedes Release.
  `install-server.ps1` lädt sie von dort und prüft die SHA256.
- **Einrichtung:** automatisch über `install-server.ps1`. Das Skript erzeugt
  ein zufälliges `turn.secret`, ermittelt die öffentliche IP, wählt Portbereiche
  außerhalb der von Windows reservierten Bereiche und legt den Dienst
  `KMDevStreamTurn` und die Firewall-Regeln an. Mit `-NoTurn` lässt du TURN weg.
- **Zugangsdaten:** Der Signaling-Server gibt pro Verbindung zeitlich begrenzte
  Zugangsdaten aus (Schema „TURN REST API“, gemeinsames `turn.secret`).
- **Sicherheit:** Der TURN-Server leitet nur an öffentliche Adressen weiter,
  nicht ins interne Netz und nicht an localhost.
- **Netzwerk:** TURN läuft direkt auf der öffentlichen IP und **nicht** über
  Cloudflare, weil es UDP braucht. Freizugeben sind TCP+UDP 3478 und der
  UDP-Relay-Bereich (Standard 49160–49260). Hat dein Hoster eine eigene
  Firewall, müssen die Ports auch dort offen sein.
- **Bandbreite:** Weitergeleiteter Verkehr läuft doppelt über den Server
  (rein und raus). Bei 6 Zuschauern mit 8 Mbit/s über TURN sind das rund
  100 Mbit/s, für eine Gigabit-Leitung kein Problem.

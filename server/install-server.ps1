<#
.SYNOPSIS
  Einmaliges Setup des KMDev-Stream-Servers auf Windows Server.

.DESCRIPTION
  - installiert die Node-Abhaengigkeiten
  - legt config.json und Caddyfile aus den Vorlagen an (falls noch nicht vorhanden)
  - laedt WinSW (Dienst-Wrapper) und Caddy (HTTPS-Proxy) herunter und prueft
    deren Pruefsummen
  - registriert Node-Server und Caddy als Windows-Dienste (ueber WinSW,
    mit Neustart bei Absturz und Log-Rotation)
  - oeffnet die Firewall fuer HTTPS und optional TURN

  Einzige Voraussetzung: Node.js LTS (https://nodejs.org, .msi-Installer).

  Als Administrator ausfuehren. Kann gefahrlos erneut ausgefuehrt werden
  (z. B. nach einem Update) - bestehende Dienste werden neu eingerichtet.

.PARAMETER Node
  Pfad zu node.exe, falls nicht im PATH.

.PARAMETER Caddy
  Pfad zu einer vorhandenen caddy.exe. Ohne Angabe wird die aktuelle Version
  von GitHub geladen (nach bin\caddy.exe).

.PARAMETER UpdateCaddy
  bin\caddy.exe neu herunterladen, auch wenn sie schon existiert.
#>
param(
  [string]$Node,
  [string]$Caddy,
  [switch]$UpdateCaddy,
  [switch]$OpenTurnPorts
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest ist sonst extrem langsam
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$here = $PSScriptRoot
$bin = Join-Path $here 'bin'
$svcDir = Join-Path $here 'service'
$logs = Join-Path $here 'logs'

# WinSW 2.12.0, eigenstaendige x64-Variante (braucht kein .NET).
$WinswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$WinswSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Bitte als Administrator ausfuehren.' }

# Dienste laufen als LocalSystem und sehen keine Netzlaufwerke, die nur fuer
# den angemeldeten Benutzer verbunden sind.
$drive = [System.IO.DriveInfo]::new((Split-Path -Qualifier $here))
if ($drive.DriveType -eq 'Network') {
  throw "$here liegt auf einem Netzlaufwerk. Bitte den server-Ordner auf eine lokale Platte kopieren (z. B. C:\kmdev-stream\server)."
}

# ---------- Node ----------

if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
  elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") { $Node = "$env:ProgramFiles\nodejs\node.exe" }
}
if (-not $Node -or -not (Test-Path $Node)) {
  throw 'Node.js nicht gefunden. Bitte Node.js LTS installieren (https://nodejs.org, .msi), dann eine NEUE PowerShell als Administrator oeffnen und das Skript erneut starten.'
}
$npm = Join-Path (Split-Path $Node) 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm' }
Write-Host "== Node: $Node ($(& $Node -v))"

Push-Location $here
try {
  & $npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'npm install fehlgeschlagen' }
} finally { Pop-Location }

# ---------- Konfiguration ----------

if (-not (Test-Path (Join-Path $here 'config.json'))) {
  Copy-Item (Join-Path $here 'config.example.json') (Join-Path $here 'config.json')
  Write-Host '   config.json angelegt - bitte pruefen.'
}
if (-not (Test-Path (Join-Path $here 'Caddyfile'))) {
  Copy-Item (Join-Path $here 'Caddyfile.example') (Join-Path $here 'Caddyfile')
  Write-Host ''
  Write-Host '   Caddyfile angelegt. Bitte darin "stream.example.com" durch deine Domain ersetzen,'
  Write-Host '   dann das Skript erneut ausfuehren.'
  exit 0
}
if ((Get-Content (Join-Path $here 'Caddyfile') -Raw) -match 'stream\.example\.com') {
  throw 'Im Caddyfile steht noch "stream.example.com" - bitte durch deine Domain ersetzen.'
}
foreach ($f in 'origin.pem', 'origin.key') {
  if (-not (Test-Path (Join-Path $here "certs\$f"))) {
    throw "certs\$f fehlt - Cloudflare-Origin-Zertifikat ablegen (siehe Caddyfile.example)."
  }
}
New-Item -ItemType Directory -Force $bin, $svcDir, $logs | Out-Null

# ---------- Port fuer den Signaling-Server ----------
# Hyper-V/WSL/WinNAT reservieren Portbereiche ("excludedportrange"); ein Port
# darin liefert EACCES, selbst als Administrator. Deshalb pruefen und bei
# Bedarf automatisch einen freien Port waehlen und in config.json eintragen.

function Get-ExcludedRanges {
  $ranges = @()
  foreach ($line in (& netsh interface ipv4 show excludedportrange protocol=tcp)) {
    if ($line -match '^\s*(\d+)\s+(\d+)') { $ranges += ,@([int]$Matches[1], [int]$Matches[2]) }
  }
  return ,$ranges
}

function Test-PortUsable([int]$port, $excluded) {
  foreach ($r in $excluded) { if ($port -ge $r[0] -and $port -le $r[1]) { return $false } }
  $l = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
  try { $l.Start(); return $true } catch { return $false } finally { try { $l.Stop() } catch {} }
}

$configPath = Join-Path $here 'config.json'
$configText = [IO.File]::ReadAllText($configPath)
$port = 8443
if ($configText -match '"port"\s*:\s*(\d+)') { $port = [int]$Matches[1] }

# Eigener Dienst wuerde den Port sonst selbst belegen.
if (Get-Service 'KMDevStream' -ErrorAction SilentlyContinue) { Stop-Service 'KMDevStream' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }

$excluded = Get-ExcludedRanges
if (-not (Test-PortUsable $port $excluded)) {
  $old = $port
  $port = @(8443, 3080, 4080, 6080, 8180, 9180, 10080, 18443, 28443) |
    Where-Object { Test-PortUsable $_ $excluded } | Select-Object -First 1
  if (-not $port) { throw "Kein freier Port gefunden. Bitte in config.json einen freien Port eintragen (siehe: netsh interface ipv4 show excludedportrange protocol=tcp)." }
  Write-Host "   Port $old ist reserviert oder belegt -> nutze Port $port"
  if ($configText -match '"port"\s*:\s*\d+') {
    $configText = $configText -replace '"port"\s*:\s*\d+', "`"port`": $port"
  } else {
    $configText = $configText -replace '^\s*\{', "{`r`n  `"port`": $port,"
  }
  # Ohne BOM schreiben, sonst scheitert JSON.parse in Node.
  [IO.File]::WriteAllText($configPath, $configText, [Text.UTF8Encoding]::new($false))
}
Write-Host "== Signaling-Port: $port"

# Caddy bekommt den Port als Umgebungsvariable. Aeltere Caddyfiles mit fest
# eingetragenem 127.0.0.1:8443 werden einmalig umgestellt.
$caddyfilePath = Join-Path $here 'Caddyfile'
$caddyText = [IO.File]::ReadAllText($caddyfilePath)
if ($caddyText -match 'reverse_proxy\s+127\.0\.0\.1:\d+') {
  $caddyText = $caddyText -replace 'reverse_proxy\s+127\.0\.0\.1:\d+', 'reverse_proxy 127.0.0.1:{$KMDEV_SIGNAL_PORT:8443}'
  [IO.File]::WriteAllText($caddyfilePath, $caddyText, [Text.UTF8Encoding]::new($false))
  Write-Host '   Caddyfile auf {$KMDEV_SIGNAL_PORT} umgestellt.'
}
$env:KMDEV_SIGNAL_PORT = "$port"

# ---------- Downloads ----------

function Get-Verified($url, $target, $algorithm, $expected) {
  $tmp = "$target.download"
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  $actual = (Get-FileHash $tmp -Algorithm $algorithm).Hash
  if ($actual -ne $expected.ToUpper()) {
    Remove-Item $tmp -Force
    throw "Pruefsumme passt nicht fuer $url"
  }
  Move-Item $tmp $target -Force
}

$winsw = Join-Path $bin 'WinSW-x64.exe'
if (-not (Test-Path $winsw) -or (Get-FileHash $winsw -Algorithm SHA256).Hash -ne $WinswSha256) {
  Write-Host '== Lade WinSW 2.12.0'
  Get-Verified $WinswUrl $winsw 'SHA256' $WinswSha256
}

if (-not $Caddy) {
  $Caddy = Join-Path $bin 'caddy.exe'
  if ($UpdateCaddy -or -not (Test-Path $Caddy)) {
    # Aktuelles Release von GitHub, geprueft gegen die offizielle checksums.txt (SHA512).
    $rel = Invoke-RestMethod 'https://api.github.com/repos/caddyserver/caddy/releases/latest' -UseBasicParsing
    $zipAsset = $rel.assets | Where-Object { $_.name -match '_windows_amd64\.zip$' } | Select-Object -First 1
    $sumAsset = $rel.assets | Where-Object { $_.name -match '_checksums\.txt$' } | Select-Object -First 1
    if (-not $zipAsset -or -not $sumAsset) { throw 'Caddy-Release auf GitHub nicht gefunden.' }
    Write-Host "== Lade Caddy $($rel.tag_name)"
    $sums = (Invoke-WebRequest $sumAsset.browser_download_url -UseBasicParsing).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($zipAsset.name) } | Select-Object -First 1
    if (-not $line) { throw 'Caddy-Pruefsumme nicht gefunden.' }
    $zip = Join-Path $bin 'caddy.zip'
    Get-Verified $zipAsset.browser_download_url $zip 'SHA512' ($line.Trim() -split '\s+')[0]
    $unz = Join-Path $bin 'caddy-unzip'
    if (Test-Path $unz) { Remove-Item $unz -Recurse -Force }
    Expand-Archive $zip $unz
    # Laufenden Dienst stoppen, sonst ist caddy.exe gesperrt.
    if (Get-Service 'KMDevStreamCaddy' -ErrorAction SilentlyContinue) { Stop-Service 'KMDevStreamCaddy' -Force }
    Copy-Item (Join-Path $unz 'caddy.exe') $Caddy -Force
    Remove-Item $unz, $zip -Recurse -Force
  }
}
if (-not (Test-Path $Caddy)) { throw "caddy.exe nicht gefunden: $Caddy" }
Write-Host "== Caddy: $(& $Caddy version)"

# Caddyfile vorab pruefen, damit der Dienst nicht in einer Neustart-Schleife landet.
# Caddy loggt auf stderr; unter 'Stop' wuerde PowerShell 5.1 das bei 2>&1
# als Fehler werten, daher hier kurz auf 'Continue'.
Push-Location $here
$ErrorActionPreference = 'Continue'
try {
  $out = & $Caddy validate --config (Join-Path $here 'Caddyfile') --adapter caddyfile 2>&1
  $code = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
}
if ($code) {
  $out | ForEach-Object { Write-Host "   $_" }
  throw 'Caddyfile ist ungueltig (Ausgabe oben).'
}
Write-Host '== Caddyfile ok'

# ---------- Dienste (WinSW) ----------
# Pro Dienst eine Kopie von WinSW mit gleichnamiger XML daneben. Das
# Arbeitsverzeichnis ist der server-Ordner, damit relative Pfade
# (config.json, certs\...) funktionieren.

function Esc($s) { [Security.SecurityElement]::Escape($s) }

function Install-Svc($id, $display, $description, $exe, $arguments, $envVars = @{}) {
  $envXml = ($envVars.GetEnumerator() | ForEach-Object { "  <env name=`"$(Esc $_.Key)`" value=`"$(Esc $_.Value)`"/>" }) -join "`r`n"
  $svcExe = Join-Path $svcDir "$id.exe"
  $svcXml = Join-Path $svcDir "$id.xml"

  if (Get-Service $id -ErrorAction SilentlyContinue) {
    Write-Host "   Entferne bestehenden Dienst $id"
    Stop-Service $id -Force -ErrorAction SilentlyContinue
    if (Test-Path $svcExe) { & $svcExe uninstall | Out-Null }
    else { & sc.exe delete $id | Out-Null }
    Start-Sleep -Seconds 2
  }

  Copy-Item $winsw $svcExe -Force
  @"
<service>
  <id>$id</id>
  <name>$(Esc $display)</name>
  <description>$(Esc $description)</description>
  <executable>$(Esc $exe)</executable>
  <arguments>$(Esc $arguments)</arguments>
  <workingdirectory>$(Esc $here)</workingdirectory>
$envXml
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$(Esc $logs)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@ | Set-Content -Path $svcXml -Encoding UTF8

  & $svcExe install
  if ($LASTEXITCODE) { throw "Dienst $id konnte nicht installiert werden." }
  & $svcExe start
  if ($LASTEXITCODE) { throw "Dienst $id konnte nicht gestartet werden - siehe logs\$id.err.log" }
  Write-Host "   Dienst $id laeuft."
}

Write-Host '== Dienste'
Install-Svc 'KMDevStream' 'KMDev Stream Signaling' 'WebSocket-Signaling fuer KMDev Stream' `
  $Node "`"$(Join-Path $here 'server.js')`""
Install-Svc 'KMDevStreamCaddy' 'KMDev Stream Caddy (HTTPS)' 'HTTPS-Reverse-Proxy fuer KMDev Stream' `
  $Caddy "run --config `"$(Join-Path $here 'Caddyfile')`" --adapter caddyfile" @{ KMDEV_SIGNAL_PORT = "$port" }

# ---------- Firewall ----------

Write-Host '== Firewall'
function Allow($name, $proto, $ports) {
  if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol $proto -LocalPort $ports -Action Allow | Out-Null
  }
  Write-Host "   $name ($proto $ports)"
}
Allow 'KMDev Stream HTTPS' TCP 443
if ($OpenTurnPorts) {
  Allow 'KMDev Stream TURN TCP' TCP 3478
  Allow 'KMDev Stream TURN UDP' UDP 3478
  Allow 'KMDev Stream TURN Relay' UDP '49152-65535'
}

# ---------- Selbsttest ----------

Start-Sleep -Seconds 2
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "== Signaling-Server antwortet lokal: ok=$($h.ok)"
} catch {
  Write-Warning 'Signaling-Server antwortet lokal nicht - siehe logs\KMDevStream.err.log'
}

Write-Host ''
Write-Host 'Fertig. Test von aussen: https://<deine-domain>/health'
Write-Host 'Tipp: Port 443 in der Firewall auf die Cloudflare-IP-Bereiche beschraenken (https://www.cloudflare.com/ips/).'

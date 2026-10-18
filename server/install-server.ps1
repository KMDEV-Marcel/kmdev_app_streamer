<#
.SYNOPSIS
  Einmaliges Setup des KM-DEV-Stream-Servers auf Windows Server.

.DESCRIPTION
  - installiert die Node-Abhaengigkeiten
  - legt config.json und Caddyfile aus den Vorlagen an (falls noch nicht vorhanden)
  - laedt WinSW (Dienst-Wrapper) und Caddy (HTTPS-Proxy) herunter und prueft
    deren Pruefsummen
  - registriert Node-Server und Caddy als Windows-Dienste (ueber WinSW,
    mit Neustart bei Absturz und Log-Rotation)
  - richtet den Medien-Server ein (kmdev-media.exe aus dem GitHub-Release):
    TURN (Relay fuer Teilnehmer hinter NAT/Firewall) und Server-Modus (SFU,
    der Server verteilt den Stream). Secrets und oeffentliche IP automatisch.
  - erzeugt den Zugangsschluessel und gibt eine Einladung fuer die App aus
  - oeffnet die Firewall fuer HTTPS, TURN und Server-Modus

  Einzige Voraussetzung: Node.js LTS (https://nodejs.org, .msi-Installer).

  Als Administrator ausfuehren. Kann gefahrlos erneut ausgefuehrt werden
  (z. B. nach einem Update) - bestehende Dienste werden neu eingerichtet.

.PARAMETER Node
  Pfad zu node.exe, falls nicht im PATH.

.PARAMETER Caddy
  Pfad zu einer vorhandenen caddy.exe. Ohne Angabe wird die aktuelle Version
  von GitHub geladen (nach bin\caddy.exe).

.PARAMETER HttpsPort
  HTTPS-Port fuer Caddy vorgeben. Ohne Angabe: 443, oder - wenn 443 belegt ist
  (z. B. IIS/Plesk) - der erste freie Cloudflare-Port aus 2053/2083/2087/2096.

.PARAMETER NoTurn
  TURN-Server nicht einrichten bzw. deaktivieren.

.PARAMETER NoSfu
  Server-Modus (SFU) nicht einrichten bzw. deaktivieren.

.PARAMETER UpdateCaddy
  bin\caddy.exe neu herunterladen, auch wenn sie schon existiert.
#>
param(
  [string]$Node,
  [string]$Caddy,
  [switch]$UpdateCaddy,
  [int]$HttpsPort,
  [switch]$NoTurn,
  [switch]$NoSfu
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
# Aeltere Caddyfiles beantworten alles ausser /ws und /health selbst; fuer die
# Browser-Seite (/watch) muss der Rest auch an Node gehen.
if ($caddyText -match 'respond\s+"KM-DEV Stream"\s+200') {
  $caddyText = $caddyText -replace 'respond\s+"KM-DEV Stream"\s+200', 'reverse_proxy 127.0.0.1:{$KMDEV_SIGNAL_PORT:8443}'
  [IO.File]::WriteAllText($caddyfilePath, $caddyText, [Text.UTF8Encoding]::new($false))
  Write-Host '   Caddyfile: Browser-Seite (/watch) freigeschaltet.'
}
$env:KMDEV_SIGNAL_PORT = "$port"

# ---------- HTTPS-Port fuer Caddy ----------
# Laeuft auf dem Server schon ein Webserver auf 443 (IIS/Plesk, Apache ...),
# kommt Caddy nicht an den Port. Dann nimmt Caddy einen der alternativen
# HTTPS-Ports, die Cloudflare unterstuetzt; in Cloudflare leitet eine
# Origin Rule den Hostnamen auf diesen Port um. Clients nutzen weiter 443.

if ($caddyText -match '(?m)^(\S+?):443\s*\{') {
  $caddyText = $caddyText -replace '(?m)^(\S+?):443(\s*\{)', '$1:{$KMDEV_HTTPS_PORT:443}$2'
  [IO.File]::WriteAllText($caddyfilePath, $caddyText, [Text.UTF8Encoding]::new($false))
  Write-Host '   Caddyfile auf {$KMDEV_HTTPS_PORT} umgestellt.'
}
$domain = if ($caddyText -match '(?m)^([A-Za-z0-9.-]+\.[A-Za-z]{2,}):') { $Matches[1] } else { $null }

# Eigenes Caddy freigeben, damit es den Port nicht selbst blockiert.
if (Get-Service 'KMDevStreamCaddy' -ErrorAction SilentlyContinue) { Stop-Service 'KMDevStreamCaddy' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }

function Get-PortOwner([int]$p) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  # PID 4 = "System" = http.sys, dahinter steckt IIS (auch bei Plesk).
  if ($c.OwningProcess -eq 4) { return 'IIS/http.sys (z. B. Plesk)' }
  if ($proc) { return "$($proc.ProcessName) (PID $($c.OwningProcess))" }
  return "PID $($c.OwningProcess)"
}

$caddyPort = $null
if ($HttpsPort) {
  $caddyPort = $HttpsPort
} else {
  foreach ($p in 443, 2053, 2083, 2087, 2096) {
    $owner = Get-PortOwner $p
    if (-not $owner -and (Test-PortUsable $p $excluded)) { $caddyPort = $p; break }
    Write-Host "   Port $p ist belegt: $owner"
  }
  if (-not $caddyPort) { throw 'Kein freier HTTPS-Port (443/2053/2083/2087/2096) gefunden. Mit -HttpsPort einen Port vorgeben.' }
}
$env:KMDEV_HTTPS_PORT = "$caddyPort"
Write-Host "== HTTPS-Port fuer Caddy: $caddyPort"

# ---------- Zugangsschluessel, TURN und Server-Modus (SFU) ----------
# Zugangsschluessel: wer streamen oder die Stream-Liste sehen will, braucht ihn
# (steckt in der Einladung, die am Ende ausgegeben wird).
# TURN und SFU laufen direkt auf der oeffentlichen IP, NICHT ueber Cloudflare
# (UDP). Secrets und oeffentliche IP werden beim ersten Lauf automatisch gesetzt.

$turnEnabled = -not $NoTurn
$sfuEnabled = -not $NoSfu
$mediaEnabled = $turnEnabled -or $sfuEnabled
$cfgObj = $configText | ConvertFrom-Json
function Set-Prop($obj, $name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
function New-Secret {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Test-WeakSecret($s) { return (-not $s) -or "$s".Length -lt 16 -or "$s" -match 'HIER-' }
if (-not $cfgObj.turn) { $cfgObj | Add-Member -NotePropertyName turn -NotePropertyValue ([pscustomobject]@{}) }
if (-not $cfgObj.sfu) { $cfgObj | Add-Member -NotePropertyName sfu -NotePropertyValue ([pscustomobject]@{}) }
$t = $cfgObj.turn
$sfu = $cfgObj.sfu
$cfgChanged = $false

if (Test-WeakSecret $cfgObj.accessKey) {
  Set-Prop $cfgObj 'accessKey' (New-Secret).Substring(0, 32)
  Write-Host '   Zugangsschluessel erzeugt.'
  $cfgChanged = $true
}

# Von Windows reservierte UDP-Bereiche (Hyper-V/WSL/WinNAT).
$udpExcluded = @()
foreach ($line in (& netsh interface ipv4 show excludedportrange protocol=udp)) {
  if ($line -match '^\s*(\d+)\s+(\d+)') { $udpExcluded += ,@([int]$Matches[1], [int]$Matches[2]) }
}
function Test-RangeFree($min, $max) {
  foreach ($r in $udpExcluded) { if ($min -le $r[1] -and $max -ge $r[0]) { return $false } }
  return $true
}
function Test-PortReserved([int]$p) {
  foreach ($r in $udpExcluded + $excluded) { if ($p -ge $r[0] -and $p -le $r[1]) { return $true } }
  return $false
}

if ($turnEnabled) {
  if (Test-WeakSecret $t.secret) {
    Set-Prop $t 'secret' (New-Secret)
    Write-Host '   TURN-Secret erzeugt.'
    $cfgChanged = $true
  }
  # Platzhalter aus alten Vorlagen (turn.example.com) entfernen: turn.urls hat
  # Vorrang vor der erkannten IP und wuerde Clients ins Leere schicken.
  if ($t.PSObject.Properties['urls']) {
    $realUrls = @($t.urls | Where-Object { "$_" -notmatch 'example\.' })
    if ($realUrls.Count -ne @($t.urls).Count) {
      Write-Host '   Platzhalter in turn.urls entfernt.'
      if ($realUrls.Count) { $t.urls = $realUrls } else { $t.PSObject.Properties.Remove('urls') }
      $cfgChanged = $true
    }
  }
  if ("$($t.host)" -match 'example\.') { Set-Prop $t 'host' ''; $cfgChanged = $true }
}

if ($mediaEnabled) {
  # Gueltige IPv4? (TryParse allein akzeptiert auch Kurzformen wie "84".)
  function Test-IPv4($s) {
    $ip = $null
    return ("$s" -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') -and [Net.IPAddress]::TryParse("$s", [ref]$ip)
  }
  if ($t.publicIp -and -not (Test-IPv4 $t.publicIp)) {
    Write-Host "   turn.publicIp '$($t.publicIp)' ist ungueltig - ermittle neu."
    Set-Prop $t 'publicIp' ''
  }
  if (-not $t.publicIp) {
    # Oeffentliche IPv4 ermitteln. Ueber Hostnamen antwortet der Dienst bei
    # bevorzugtem IPv6 mit der IPv6-Adresse, daher IPv4-erzwingende Quellen.
    $found = $null
    foreach ($src in @(
        @{ Url = 'https://1.1.1.1/cdn-cgi/trace'; Pattern = '(?m)^ip=(\S+)\s*$' },
        @{ Url = 'https://api.ipify.org'; Pattern = '^\s*(\S+)\s*$' }
      )) {
      try {
        $body = (Invoke-WebRequest $src.Url -UseBasicParsing -TimeoutSec 10).Content
        if ($body -is [byte[]]) { $body = [Text.Encoding]::ASCII.GetString($body) }
        # Treffer sofort sichern: ein weiteres -match wuerde $Matches ueberschreiben.
        if ($body -match $src.Pattern) {
          $candidate = $Matches[1]
          if (Test-IPv4 $candidate) { $found = $candidate; break }
        }
      } catch { }
    }
    if (-not $found) {
      # Ohne Internet-Abfrage: genau eine oeffentliche IPv4 auf den Netzwerkkarten?
      $nicIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
          $a = $_.IPAddress
          $a -notmatch '^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)'
        } | ForEach-Object { $_.IPAddress })
      if ($nicIps.Count -eq 1) { $found = $nicIps[0] }
      elseif ($nicIps.Count -gt 1) { throw "Mehrere oeffentliche IPv4-Adressen gefunden ($($nicIps -join ', ')). Bitte die gewuenschte als turn.publicIp in config.json eintragen." }
    }
    if (-not $found) { throw 'Oeffentliche IPv4 nicht ermittelbar. Bitte turn.publicIp in config.json eintragen.' }
    Set-Prop $t 'publicIp' $found
    Write-Host "   Oeffentliche IPv4 erkannt: $found"
    $cfgChanged = $true
  }
}

if ($turnEnabled) {
  $turnPort = if ($t.listenPort) { [int]$t.listenPort } else { 3478 }
  if (Test-PortReserved $turnPort) { throw "TURN-Port $turnPort ist von Windows reserviert. Bitte turn.listenPort in config.json aendern." }
  $relayMin = if ($t.relayPortMin) { [int]$t.relayPortMin } else { 49160 }
  $relayMax = if ($t.relayPortMax) { [int]$t.relayPortMax } else { 49260 }
  if (-not (Test-RangeFree $relayMin $relayMax)) {
    $old = "$relayMin-$relayMax"
    $pick = @(@(40000, 40100), @(30000, 30100), @(20000, 20100), @(10000, 10100)) | Where-Object { Test-RangeFree $_[0] $_[1] } | Select-Object -First 1
    if (-not $pick) { throw 'Kein freier UDP-Relay-Bereich gefunden. Bitte turn.relayPortMin/Max in config.json setzen.' }
    $relayMin = $pick[0]; $relayMax = $pick[1]
    Write-Host "   Relay-Bereich $old ist reserviert -> nutze $relayMin-$relayMax"
  }
  foreach ($kv in @{ enabled = $true; listenPort = $turnPort; relayPortMin = $relayMin; relayPortMax = $relayMax }.GetEnumerator()) {
    if ($t.PSObject.Properties[$kv.Key] -and $t.($kv.Key) -eq $kv.Value) { continue }
    Set-Prop $t $kv.Key $kv.Value
    $cfgChanged = $true
  }
  Write-Host "== TURN: $($t.publicIp):$turnPort (UDP+TCP), Relay UDP $relayMin-$relayMax"
} elseif ($t.enabled) {
  Set-Prop $t 'enabled' $false
  $cfgChanged = $true
}

if ($sfuEnabled) {
  if (Test-WeakSecret $sfu.secret) {
    Set-Prop $sfu 'secret' (New-Secret)
    $cfgChanged = $true
  }
  $sfuPort = if ($sfu.udpPort) { [int]$sfu.udpPort } else { 3479 }
  if (Test-PortReserved $sfuPort) {
    $old = $sfuPort
    $sfuPort = @(3479, 3480, 5349, 8478, 9478, 19302) | Where-Object { -not (Test-PortReserved $_) -and $_ -ne $turnPort } | Select-Object -First 1
    if (-not $sfuPort) { throw 'Kein freier Port fuer den Server-Modus gefunden. Bitte sfu.udpPort in config.json setzen.' }
    Write-Host "   Port $old ist reserviert -> Server-Modus nutzt Port $sfuPort"
  }
  foreach ($kv in @{ enabled = $true; udpPort = $sfuPort }.GetEnumerator()) {
    if ($sfu.PSObject.Properties[$kv.Key] -and $sfu.($kv.Key) -eq $kv.Value) { continue }
    Set-Prop $sfu $kv.Key $kv.Value
    $cfgChanged = $true
  }
  Write-Host "== Server-Modus (SFU): $($t.publicIp):$sfuPort (UDP+TCP)"
} elseif ($sfu.enabled) {
  Set-Prop $sfu 'enabled' $false
  $cfgChanged = $true
}

if ($cfgChanged) {
  $configText = $cfgObj | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($configPath, $configText, [Text.UTF8Encoding]::new($false))
}

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

# Medien-Server (TURN + SFU) aus dem neuesten Release dieses Repos (dort von
# GitHub Actions gebaut). Bis v0.1.x hiess er kmdev-turn.exe und war nur TURN.
$mediaExe = Join-Path $bin 'kmdev-media.exe'
if ($mediaEnabled) {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/KMDEV-Marcel/kmdev_app_streamer/releases/latest' -UseBasicParsing
  $exeAsset = $rel.assets | Where-Object { $_.name -eq 'kmdev-media.exe' } | Select-Object -First 1
  $sumAsset = $rel.assets | Where-Object { $_.name -eq 'kmdev-media.exe.sha256' } | Select-Object -First 1
  if (-not $exeAsset -or -not $sumAsset) { throw "Im Release $($rel.tag_name) fehlt kmdev-media.exe - bitte ein neueres Release abwarten." }
  $sum = (Invoke-WebRequest $sumAsset.browser_download_url -UseBasicParsing).Content
  if ($sum -is [byte[]]) { $sum = [Text.Encoding]::ASCII.GetString($sum) }
  $expected = ($sum.Trim() -split '\s+')[0].ToUpper()
  if (-not (Test-Path $mediaExe) -or (Get-FileHash $mediaExe -Algorithm SHA256).Hash -ne $expected) {
    Write-Host "== Lade Medien-Server ($($rel.tag_name))"
    if (Get-Service 'KMDevStreamMedia' -ErrorAction SilentlyContinue) { Stop-Service 'KMDevStreamMedia' -Force }
    Get-Verified $exeAsset.browser_download_url $mediaExe 'SHA256' $expected
  }
}

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
Install-Svc 'KMDevStream' 'KM-DEV Stream Signaling' 'WebSocket-Signaling fuer KM-DEV Stream' `
  $Node "`"$(Join-Path $here 'server.js')`""
Install-Svc 'KMDevStreamCaddy' 'KM-DEV Stream Caddy (HTTPS)' 'HTTPS-Reverse-Proxy fuer KM-DEV Stream' `
  $Caddy "run --config `"$(Join-Path $here 'Caddyfile')`" --adapter caddyfile" @{ KMDEV_SIGNAL_PORT = "$port"; KMDEV_HTTPS_PORT = "$caddyPort" }
function Remove-Svc($id) {
  if (-not (Get-Service $id -ErrorAction SilentlyContinue)) { return }
  Stop-Service $id -Force -ErrorAction SilentlyContinue
  $svcExe = Join-Path $svcDir "$id.exe"
  if (Test-Path $svcExe) { & $svcExe uninstall | Out-Null } else { & sc.exe delete $id | Out-Null }
  Start-Sleep -Seconds 1
  Remove-Item (Join-Path $svcDir "$id.*") -Force -ErrorAction SilentlyContinue
  Write-Host "   Dienst $id entfernt."
}
# Alter reiner TURN-Dienst (bis v0.1.x) - abgeloest durch KMDevStreamMedia.
Remove-Svc 'KMDevStreamTurn'
Remove-Item (Join-Path $bin 'kmdev-turn.exe') -Force -ErrorAction SilentlyContinue
if ($mediaEnabled) {
  Install-Svc 'KMDevStreamMedia' 'KM-DEV Stream Medien-Server' 'TURN-Relay und Server-Modus (SFU) fuer KM-DEV Stream' `
    $mediaExe "-config `"$configPath`""
} else {
  Remove-Svc 'KMDevStreamMedia'
}

# ---------- Firewall ----------

Write-Host '== Firewall'
# Regeln immer neu anlegen, damit geaenderte Ports (z. B. Relay-Bereich) greifen.
function Allow($name, $proto, $ports) {
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol $proto -LocalPort $ports -Action Allow | Out-Null
  Write-Host "   $name ($proto $ports)"
}
Allow "KMDev Stream HTTPS $caddyPort" TCP $caddyPort
if ($turnEnabled) {
  Allow 'KMDev Stream TURN TCP' TCP $turnPort
  Allow 'KMDev Stream TURN UDP' UDP $turnPort
  Allow 'KMDev Stream TURN Relay' UDP "$relayMin-$relayMax"
}
if ($sfuEnabled) {
  Allow 'KMDev Stream Server-Modus UDP' UDP $sfuPort
  Allow 'KMDev Stream Server-Modus TCP' TCP $sfuPort
}

# ---------- Selbsttest ----------

Start-Sleep -Seconds 2
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "== Signaling-Server antwortet lokal: ok=$($h.ok)"
} catch {
  Write-Warning 'Signaling-Server antwortet lokal nicht - siehe logs\KMDevStream.err.log'
}

# Caddy so testen, wie Cloudflare es erreicht: TLS mit SNI = Domain. Das
# Origin-Zertifikat ist nur fuer Cloudflare gueltig, daher -k.
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($domain -and $curl) {
  $ErrorActionPreference = 'Continue'
  $res = & $curl.Source -sk --max-time 5 --resolve "${domain}:${caddyPort}:127.0.0.1" "https://${domain}:${caddyPort}/health" 2>&1
  $ErrorActionPreference = 'Stop'
  if ("$res" -match '"ok"\s*:\s*true') { Write-Host "== Caddy (HTTPS $caddyPort) antwortet lokal mit Zertifikat fuer $domain" }
  else { Write-Warning "Caddy antwortet lokal nicht auf HTTPS $caddyPort - siehe logs\KMDevStreamCaddy.err.log" }
}

# TURN: STUN-Binding-Request per UDP an den lokalen TURN-Server.
if ($turnEnabled) {
  $udp = [System.Net.Sockets.UdpClient]::new()
  try {
    $udp.Client.ReceiveTimeout = 3000
    # Header: Typ 0x0001 (Binding Request), Laenge 0, Magic Cookie, 12 Byte Transaktions-ID
    $req = [byte[]](0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42) + [byte[]](1..12 | ForEach-Object { Get-Random -Maximum 256 })
    [void]$udp.Send($req, $req.Length, '127.0.0.1', $turnPort)
    $ep = [System.Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
    $resp = $udp.Receive([ref]$ep)
    if ($resp.Length -ge 2 -and $resp[0] -eq 0x01 -and $resp[1] -eq 0x01) { Write-Host "== TURN-Server antwortet lokal auf UDP $turnPort" }
    else { Write-Warning 'TURN-Server antwortet unerwartet - siehe logs\KMDevStreamMedia.err.log' }
  } catch {
    Write-Warning 'TURN-Server antwortet lokal nicht - siehe logs\KMDevStreamMedia.err.log'
  } finally { $udp.Close() }
}

# Server-Modus: Die SFU meldet sich beim Signaling-Server an (/health -> sfu).
if ($sfuEnabled) {
  $sfuOk = $false
  foreach ($i in 1..10) {
    try { if ((Invoke-RestMethod "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 3).sfu) { $sfuOk = $true; break } } catch { }
    Start-Sleep -Seconds 1
  }
  if ($sfuOk) { Write-Host '== Server-Modus (SFU) ist mit dem Signaling-Server verbunden' }
  else { Write-Warning 'Server-Modus (SFU) meldet sich nicht - siehe logs\KMDevStreamMedia.err.log' }
}

$shown = if ($domain) { $domain } else { '<deine-domain>' }
if ($mediaEnabled) {
  $open = @()
  if ($turnEnabled) { $open += "TCP $turnPort", "UDP $turnPort", "UDP $relayMin-$relayMax" }
  if ($sfuEnabled) { $open += "UDP $sfuPort", "TCP $sfuPort" }
  Write-Host ''
  Write-Host 'Falls dein Hoster eine eigene Firewall vor dem Server hat, dort freigeben:'
  Write-Host "  $($open -join ', ')  (direkt auf $($t.publicIp), nicht ueber Cloudflare)"
}
Write-Host ''
if ($caddyPort -ne 443) {
  Write-Host "WICHTIG - Port 443 ist belegt, Caddy laeuft auf Port $caddyPort."
  Write-Host 'In Cloudflare dafuer eine Origin Rule anlegen:'
  Write-Host '  Regeln -> Origin Rules -> Regel erstellen'
  Write-Host "  Wenn: Hostname ist gleich $shown"
  Write-Host "  Dann: Zielport -> Umschreiben auf $caddyPort"
  Write-Host ''
}

# Einladung fuer die App: richtet Server-Adresse und Zugangsschluessel ein
# (App -> Einstellungen -> "Einladung einfuegen"). Gleiches Format wie
# renderer/invite.js: base64url von {"s": <server>, "k": <schluessel>}.
if ($domain) {
  $inviteJson = [pscustomobject]@{ s = "wss://$domain/ws"; k = "$($cfgObj.accessKey)" } | ConvertTo-Json -Compress
  $inviteData = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($inviteJson)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Write-Host 'Einladung fuer die App (enthaelt den Zugangsschluessel - nur an Vertraute geben):'
  Write-Host "  kmdev-stream://setup/$inviteData"
  Write-Host '  In der App: Einstellungen -> Einladung einfuegen -> Speichern.'
  Write-Host ''
}
Write-Host "Fertig. Test von aussen: https://$shown/health"
Write-Host "Tipp: Port $caddyPort in der Firewall auf die Cloudflare-IP-Bereiche beschraenken (https://www.cloudflare.com/ips/)."

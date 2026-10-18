<#
.SYNOPSIS
  Einmaliges Setup des KMDev-Stream-Servers auf Windows Server.

.DESCRIPTION
  - installiert die Node-Abhaengigkeiten
  - legt config.json aus der Vorlage an (falls noch nicht vorhanden)
  - registriert Node-Server und Caddy als Windows-Dienste (ueber NSSM)
  - oeffnet die Firewall fuer HTTPS (Caddy) und optional TURN

  Voraussetzungen (vorher installieren, in PATH oder per Parameter):
    node.exe  - https://nodejs.org (LTS)
    nssm.exe  - https://nssm.cc
    caddy.exe - https://caddyserver.com/download

  Als Administrator ausfuehren.
#>
param(
  [string]$Nssm = 'nssm',
  [string]$Caddy = 'caddy',
  [switch]$OpenTurnPorts
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Bitte als Administrator ausfuehren.' }

# Dienste laufen als LocalSystem und sehen keine Netzlaufwerke, die nur fuer
# den angemeldeten Benutzer verbunden sind.
$drive = [System.IO.DriveInfo]::new((Split-Path -Qualifier $here))
if ($drive.DriveType -eq 'Network') {
  throw "$here liegt auf einem Netzlaufwerk. Bitte den server-Ordner auf eine lokale Platte kopieren (z. B. C:\kmdev-stream\server)."
}

$node = (Get-Command node -ErrorAction Stop).Source
$nssmExe = (Get-Command $Nssm -ErrorAction Stop).Source
$caddyExe = (Get-Command $Caddy -ErrorAction Stop).Source

Write-Host '== Abhaengigkeiten'
Push-Location $here
try { & npm install --omit=dev; if ($LASTEXITCODE) { throw 'npm install fehlgeschlagen' } } finally { Pop-Location }

if (-not (Test-Path (Join-Path $here 'config.json'))) {
  Copy-Item (Join-Path $here 'config.example.json') (Join-Path $here 'config.json')
  Write-Host '   config.json angelegt - bitte pruefen.'
}
if (-not (Test-Path (Join-Path $here 'Caddyfile'))) {
  Copy-Item (Join-Path $here 'Caddyfile.example') (Join-Path $here 'Caddyfile')
  Write-Host '   Caddyfile angelegt - DOMAIN UND PFAD ANPASSEN, dann Skript erneut ausfuehren.'
  exit 0
}
New-Item -ItemType Directory -Force (Join-Path $here 'certs') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $here 'logs') | Out-Null

function Install-Svc($name, $exe, $arguments, $display) {
  if (Get-Service $name -ErrorAction SilentlyContinue) {
    & $nssmExe stop $name | Out-Null
    & $nssmExe remove $name confirm | Out-Null
  }
  & $nssmExe install $name $exe $arguments | Out-Null
  & $nssmExe set $name AppDirectory $here | Out-Null
  & $nssmExe set $name DisplayName $display | Out-Null
  & $nssmExe set $name Start SERVICE_AUTO_START | Out-Null
  & $nssmExe set $name AppStdout (Join-Path $here "logs\$name.log") | Out-Null
  & $nssmExe set $name AppStderr (Join-Path $here "logs\$name.log") | Out-Null
  & $nssmExe set $name AppRotateFiles 1 | Out-Null
  & $nssmExe set $name AppRotateBytes 10485760 | Out-Null
  & $nssmExe start $name | Out-Null
  Write-Host "   Dienst $name laeuft."
}

foreach ($f in 'origin.pem', 'origin.key') {
  if (-not (Test-Path (Join-Path $here "certs\$f"))) {
    throw "certs\$f fehlt - Cloudflare-Origin-Zertifikat ablegen (siehe Caddyfile.example)."
  }
}

Write-Host '== Dienste'
Install-Svc 'KMDevStream' $node "`"$(Join-Path $here 'server.js')`"" 'KMDev Stream Signaling'
Install-Svc 'KMDevStreamCaddy' $caddyExe "run --config `"$(Join-Path $here 'Caddyfile')`"" 'KMDev Stream Caddy (HTTPS)'

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

Write-Host ''
Write-Host 'Fertig. Test: https://<deine-domain>/health'
Write-Host 'Tipp: Port 443 in der Firewall auf die Cloudflare-IP-Bereiche beschraenken (https://www.cloudflare.com/ips/).'

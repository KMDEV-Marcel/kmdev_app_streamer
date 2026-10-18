# Baut native\bin\kmdev-audio.exe mit MSVC (Visual Studio 2022 oder Build Tools,
# Workload "Desktopentwicklung mit C++"). Laeuft lokal und in GitHub Actions.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio mit C++-Werkzeugen nicht gefunden.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$out = Join-Path $here 'bin'
New-Item -ItemType Directory -Force $out | Out-Null
$src = Join-Path $here 'kmdev-audio.cpp'
$obj = Join-Path $out 'kmdev-audio.obj'
$exe = Join-Path $out 'kmdev-audio.exe'
# /MT: statisch gelinkt, braucht keine VC++-Redistributable beim Nutzer.
cmd /c "`"$vcvars`" >nul && cl /nologo /std:c++17 /O2 /MT /EHsc /W3 /DUNICODE /D_UNICODE /Fo`"$obj`" /Fe`"$exe`" `"$src`" /link /SUBSYSTEM:CONSOLE"
if ($LASTEXITCODE) { throw 'Kompilieren fehlgeschlagen.' }
Remove-Item $obj -ErrorAction SilentlyContinue
Write-Host "Gebaut: $exe"

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force desktop-artifacts | Out-Null
$setup = Get-ChildItem apps/desktop/src-tauri/target/release/bundle/nsis -Filter *.exe | Select-Object -First 1
if (-not $setup) {
    Write-Error "Windows NSIS setup.exe not found"
}
Copy-Item $setup.FullName desktop-artifacts/bilibili-notify-windows-x64-setup.exe
$portableRoot = Join-Path $env:RUNNER_TEMP ("bilibili-notify-windows-portable-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $portableRoot | Out-Null
Copy-Item "apps/desktop/src-tauri/target/release/bilibili-notify-desktop.exe" (Join-Path $portableRoot "bilibili-notify-desktop.exe")
Copy-Item "apps/desktop/src-tauri/target/release/resources" (Join-Path $portableRoot "resources") -Recurse
Compress-Archive -Path (Join-Path $portableRoot "*") -DestinationPath desktop-artifacts/bilibili-notify-windows-x64.zip -Force

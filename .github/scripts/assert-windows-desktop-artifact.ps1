$ErrorActionPreference = "Stop"

$tmp = Join-Path $env:RUNNER_TEMP ("desktop-artifact-check-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
Expand-Archive -LiteralPath desktop-artifacts/bilibili-notify-windows-x64.zip -DestinationPath $tmp -Force
$resourcesDir = Join-Path $tmp "resources"
$required = @(
    "bilibili-notify-desktop.exe",
    "resources/node/bin/node.exe",
    "resources/app/apps/server/lib/index.mjs",
    "resources/BUILD_INFO.json"
)
foreach ($rel in $required) {
    if (-not (Test-Path (Join-Path $tmp $rel))) {
        Write-Error "Windows portable artifact missing $rel"
    }
}
$forbidden = Get-ChildItem $resourcesDir -Recurse -Force | Where-Object {
    $_.Name -in @("bn.config.yaml", "bn.config.yml", "bn.config.json", "master.key") -or
    $_.Name -like ".env*" -or
    $_.Extension -in @(".pem", ".key", ".enc") -or
    $_.FullName -like "*\resources\app\apps\server\data" -or
    $_.FullName -like "*\resources\app\apps\server\data\*" -or
    $_.FullName -like "*\resources\app\apps\server\logs" -or
    $_.FullName -like "*\resources\app\apps\server\logs\*" -or
    $_.FullName -like "*\resources\app\node_modules\.pnpm" -or
    $_.FullName -like "*\resources\app\node_modules\.pnpm\*"
} | Select-Object -First 1
if ($forbidden) {
    Write-Error "Windows portable artifact contains forbidden runtime file: $($forbidden.FullName)"
}

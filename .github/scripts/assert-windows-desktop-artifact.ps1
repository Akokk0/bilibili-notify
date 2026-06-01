$ErrorActionPreference = "Stop"

function Assert-WindowsGuiSubsystem {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 0x100) {
        Write-Error "Windows exe is too small to contain a PE header: $Path"
    }
    $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3c)
    $subsystemOffset = $peOffset + 4 + 20 + 68
    if ($subsystemOffset + 2 -gt $bytes.Length) {
        Write-Error "Windows exe PE optional header is truncated: $Path"
    }
    $subsystem = [System.BitConverter]::ToUInt16($bytes, $subsystemOffset)
    if ($subsystem -ne 2) {
        Write-Error "Windows desktop exe must use GUI subsystem (2), got $subsystem"
    }
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return $listener.LocalEndpoint.Port
    }
    finally {
        $listener.Stop()
    }
}

function Start-SidecarSmokeProcess {
    param(
        [string]$NodePath,
        [string]$ServerDir,
        [string]$ServerEntry,
        [string]$WebDist,
        [string]$DataDir,
        [int]$Port,
        [string]$StdoutPath,
        [string]$StderrPath
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $NodePath
    foreach ($arg in @($ServerEntry, "--host", "127.0.0.1", "--port", $Port.ToString(), "--data-dir", $DataDir, "--web-dist", $WebDist)) {
        [void]$psi.ArgumentList.Add($arg)
    }
    $psi.WorkingDirectory = $ServerDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Environment["BN_CONFIG_DISABLED"] = "1"
    $psi.Environment["BN_ALLOW_NO_AUTH"] = "1"
    $psi.Environment["BN_DESKTOP_TOKEN"] = "desktop-smoke-token"
    $psi.Environment["BN_DESKTOP_ALLOWED_ORIGIN"] = "http://127.0.0.1:$Port"
    $psi.Environment["NODE_ENV"] = "production"

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    [void]$process.Start()

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process | Add-Member -NotePropertyName StdoutTask -NotePropertyValue $stdoutTask
    $process | Add-Member -NotePropertyName StderrTask -NotePropertyValue $stderrTask
    $process | Add-Member -NotePropertyName StdoutPath -NotePropertyValue $StdoutPath
    $process | Add-Member -NotePropertyName StderrPath -NotePropertyValue $StderrPath
    return $process
}

function Stop-SidecarSmokeProcess {
    param($Process)

    if ($null -eq $Process) {
        return
    }
    if (-not $Process.HasExited) {
        $Process.Kill($true)
        $Process.WaitForExit(10000) | Out-Null
    }
    $stdout = $Process.StdoutTask.GetAwaiter().GetResult()
    $stderr = $Process.StderrTask.GetAwaiter().GetResult()
    Set-Content -LiteralPath $Process.StdoutPath -Value $stdout -Encoding UTF8
    Set-Content -LiteralPath $Process.StderrPath -Value $stderr -Encoding UTF8
}

$tmp = Join-Path $env:RUNNER_TEMP ("desktop-artifact-check-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
Expand-Archive -LiteralPath desktop-artifacts/bilibili-notify-windows-x64.zip -DestinationPath $tmp -Force
$resourcesDir = Join-Path $tmp "resources"
$desktopExe = Join-Path $tmp "bilibili-notify-desktop.exe"
$nodePath = Join-Path $resourcesDir "node/bin/node.exe"
$serverDir = Join-Path $resourcesDir "app/apps/server"
$serverEntry = Join-Path $serverDir "lib/index.mjs"
$webDist = Join-Path $resourcesDir "app/apps/web/dist"
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
Assert-WindowsGuiSubsystem $desktopExe

$smokeDataDir = Join-Path $tmp "smoke-data"
$stdoutPath = Join-Path $tmp "sidecar-smoke.stdout.log"
$stderrPath = Join-Path $tmp "sidecar-smoke.stderr.log"
New-Item -ItemType Directory -Force $smokeDataDir | Out-Null
$port = Get-FreeTcpPort
$sidecar = $null
try {
    $sidecar = Start-SidecarSmokeProcess -NodePath $nodePath -ServerDir $serverDir -ServerEntry $serverEntry -WebDist $webDist -DataDir $smokeDataDir -Port $port -StdoutPath $stdoutPath -StderrPath $stderrPath
    $ready = $false
    for ($i = 0; $i -lt 30; $i += 1) {
        if ($sidecar.HasExited) {
            Stop-SidecarSmokeProcess $sidecar
            Write-Error "Windows sidecar exited before health check passed. ExitCode=$($sidecar.ExitCode). stderr: $(Get-Content -LiteralPath $stderrPath -Raw)"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
            if ($health.status -eq "ok") {
                $ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $ready) {
        Stop-SidecarSmokeProcess $sidecar
        Write-Error "Windows sidecar did not return /api/health status ok. stderr: $(Get-Content -LiteralPath $stderrPath -Raw)"
    }
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 5
    if ($response.Headers["Content-Type"] -notlike "text/html*") {
        Write-Error "Windows sidecar GET / expected text/html, got $($response.Headers["Content-Type"])"
    }
    if ($response.Content -notlike "*<div id=`"root`">*") {
        Write-Error "Windows sidecar GET / did not return dashboard index.html"
    }
}
finally {
    Stop-SidecarSmokeProcess $sidecar
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

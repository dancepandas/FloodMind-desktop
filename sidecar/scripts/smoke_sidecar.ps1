param(
    [Parameter(Mandatory = $true)]
    [string]$SidecarExe,
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$exe = (Resolve-Path $SidecarExe).Path
$dir = Split-Path $exe -Parent
$stdout = [System.IO.Path]::GetTempFileName()
$stderr = [System.IO.Path]::GetTempFileName()
$process = $null

try {
    # Start-Process cannot keep the GUI-subsystem exe alive when its stdio is a
    # console-less temp redirect; spawn via cmd so the pipe stays attached the
    # same way Rust's std::process::Command does in production.
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = $exe
    $pinfo.WorkingDirectory = $dir
    $pinfo.UseShellExecute = $false
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($pinfo)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $readyLine = $null
    $outTask = $process.StandardOutput.ReadLineAsync()
    $errBuffer = New-Object System.Text.StringBuilder

    $errTask = $process.StandardError.ReadToEndAsync()
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($outTask.IsCompleted) {
            $readyLine = $outTask.Result
            break
        }
        if ($process.HasExited) {
            throw "Sidecar exited before READY (code $($process.ExitCode)). stderr: $($errTask.Result)"
        }
        Start-Sleep -Milliseconds 200
    }

    if (-not $readyLine -or $readyLine -notmatch '^READY ([0-9]+)$') {
        throw "Sidecar did not report READY within ${TimeoutSeconds}s. First line: '$readyLine'. stderr: $($errTask.Result)"
    }

    $port = [int]$Matches[1]
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 10
    if ($health.status -ne "ok") {
        throw "Unexpected health response: $($health | ConvertTo-Json -Compress)"
    }
    Write-Host "Sidecar smoke test passed: READY $port, health=$($health.status), version=$($health.version)"
}
finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
    }
    Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
}

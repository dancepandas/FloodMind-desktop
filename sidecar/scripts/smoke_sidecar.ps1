param(
    [Parameter(Mandatory = $true)]
    [string]$SidecarExe,
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$exe = (Resolve-Path $SidecarExe).Path
$stdout = [System.IO.Path]::GetTempFileName()
$stderr = [System.IO.Path]::GetTempFileName()
$process = $null

try {
    $process = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $line = $null

    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path $stdout) {
            $line = Get-Content $stdout -TotalCount 1 -ErrorAction SilentlyContinue
            if ($line) { break }
        }
        if ($process.HasExited) {
            $errText = Get-Content $stderr -Raw -ErrorAction SilentlyContinue
            throw "Sidecar exited before READY (code $($process.ExitCode)): $errText"
        }
        Start-Sleep -Milliseconds 200
        $process.Refresh()
    }

    if (-not $line -or $line -notmatch '^READY ([0-9]+)$') {
        $errText = Get-Content $stderr -Raw -ErrorAction SilentlyContinue
        throw "Sidecar did not report READY within ${TimeoutSeconds}s. First line: '$line'. stderr: $errText"
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

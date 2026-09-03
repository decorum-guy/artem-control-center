param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCurrentHead,
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedTargetHead,
    [ValidatePattern('^[0-9a-f]{24}$')]
    [string]$RequestId
)

$ErrorActionPreference = "Stop"

# This is intentionally a short-lived bootstrap.  The updater is created by
# Start-Process and this process exits immediately, before Stop-ArtemRuntime
# can traverse the production supervisor tree with taskkill /T.
$runtimeRoot = Join-Path $env:LOCALAPPDATA "ArtemControlCenter"
$receiptPath = Join-Path $runtimeRoot "update-launch.json"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$targetScript = Join-Path $PSScriptRoot "update-production.ps1"

function Write-ArtemUpdaterLaunchReceipt {
    param(
        [Parameter(Mandatory)][ValidateSet("runtime-process-created")][string]$Stage,
        [Parameter(Mandatory)][ValidateSet("recorded", "child-start-failed")][string]$Result,
        [int]$ProcessId = 0
    )
    try {
        New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
        $payload = [ordered]@{
            schemaVersion = 1
            requestId = $RequestId.ToLowerInvariant()
            stage = $Stage
            result = $Result
            processId = if ($ProcessId -gt 0) { $ProcessId } else { $null }
            updatedAt = [DateTime]::UtcNow.ToString("o")
        }
        $temporary = "$receiptPath.$PID.tmp"
        [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json -Compress), [Text.Encoding]::ASCII)
        if (Test-Path -LiteralPath $receiptPath) {
            [IO.File]::Replace($temporary, $receiptPath, [System.Management.Automation.Language.NullString]::Value)
        }
        else {
            [IO.File]::Move($temporary, $receiptPath)
        }
    }
    catch {
        Remove-Item -LiteralPath "$receiptPath.$PID.tmp" -Force -ErrorAction SilentlyContinue
        throw
    }
}

try {
    if (-not (Test-Path -LiteralPath $targetScript -PathType Leaf)) {
        throw "Canonical production updater script is missing"
    }

    # Start-Process receives only the fixed repository updater and the three
    # validated transaction identifiers.  The quoted path is the sole value
    # that can contain whitespace; no command string or browser input exists.
    $targetScriptArgument = '"{0}"' -f $targetScript
    $updater = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", $targetScriptArgument,
            "-ExpectedCurrentHead", $ExpectedCurrentHead,
            "-ExpectedTargetHead", $ExpectedTargetHead,
            "-RequestId", $RequestId
        ) `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -PassThru

    if ($null -eq $updater -or $updater.Id -le 0) {
        throw "Canonical production updater process was not created"
    }
    Write-ArtemUpdaterLaunchReceipt -Stage "runtime-process-created" -Result "recorded" -ProcessId $updater.Id
    exit 0
}
catch {
    try {
        Write-ArtemUpdaterLaunchReceipt -Stage "runtime-process-created" -Result "child-start-failed"
    }
    catch {
        # A missing receipt is itself a bounded launch failure; the supervisor
        # must not infer success from the bootstrap process exit code.
    }
    exit 1
}

$ErrorActionPreference = "Stop"
$target = "a" * 40
$previous = "b" * 40
$request = "c" * 24
. (Join-Path $PSScriptRoot "apply-automatic-update.ps1") -RepoRoot (Join-Path $PSScriptRoot "..\..") -ExpectedTargetHead $target -ContractTest
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
$success = @{ requestId=$request; targetHead=$target; servedRevision=$target; status="success"; result="updated" }
$arguments = @{ State=$success; ExpectedRequest=$request; ExpectedTarget=$target; PreviousRevision=$previous; TargetHealthy=$true; PreviousHealthy=$false; TransactionActive=$false; LockActive=$false }
$result = Get-ArtemAutomaticUpdateResult @arguments
Assert-True ($result.status -eq "deployed" -and $result.revision -eq $target -and $result.code -eq 0) "Exact ready target must succeed"
foreach ($field in @("LockActive", "TransactionActive")) {
    $case = $arguments.Clone(); $case[$field]=$true
    Assert-True ($null -eq (Get-ArtemAutomaticUpdateResult @case)) "A live updater owner must keep host ownership"
}
$case = $arguments.Clone(); $case.TargetHealthy=$false
Assert-True ($null -eq (Get-ArtemAutomaticUpdateResult @case)) "Terminal success without readiness is not deployment"
$case = $arguments.Clone(); $case.State=@{ requestId=$request; targetHead=$target; servedRevision=$previous; status="success"; result="updated" }
Assert-True ($null -eq (Get-ArtemAutomaticUpdateResult @case)) "Wrong served revision must not succeed"
$case = $arguments.Clone(); $case.ExpectedRequest="d" * 24
Assert-True ($null -eq (Get-ArtemAutomaticUpdateResult @case)) "Another request's terminal result must be ignored"
$case = $arguments.Clone(); $case.State=@{ requestId=$request; targetHead=$target; status="failed"; result="rollback_restored" }; $case.PreviousHealthy=$true
$result = Get-ArtemAutomaticUpdateResult @case
Assert-True ($result.status -eq "rolled_back" -and $result.revision -eq $previous) "Healthy rollback must retain prior revision"
$case.PreviousHealthy=$false
Assert-True ($null -eq (Get-ArtemAutomaticUpdateResult @case)) "Unverified rollback must remain unknown"
$case.PreviousHealthy=$true; $case.State.result="pre_update_failed"
$result = Get-ArtemAutomaticUpdateResult @case
Assert-True ($result.status -eq "deferred" -and $result.code -eq 1) "Request-bound pre-update failure must permit another bounded preflight"
$case.State.result="build_failed"
$result = Get-ArtemAutomaticUpdateResult @case
Assert-True ($result.status -eq "failed_healthy" -and $result.code -eq 1) "A real failed candidate must not be automatically replayed"

# Read-only preflight failure cannot poison a candidate during cold startup.
# Unknown prior transaction or possible CreateProcess always require recovery.
foreach ($possible in @($false, $true)) {
    foreach ($clear in @($false, $true)) {
        $failure = Get-ArtemAutomaticFailureResult -PossibleDispatch $possible -TransactionStateKnownClear $clear
        $expectedStatus = if (-not $possible -and $clear) { "deferred" } else { "uncertain" }
        Assert-True ($failure.status -eq $expectedStatus) "Preflight/dispatch boundary classification must fail closed"
    }
}
$unknownPayload = New-ArtemAutomaticResultPayload -Status "deferred" -Revision $null | ConvertTo-Json -Compress | ConvertFrom-Json
Assert-True ($null -eq $unknownPayload.revision -and $unknownPayload.status -eq "deferred") "Deferred unknown revision must be JSON null, never empty string"

# Execute the actual spawn function against a deliberately failing cmdlet stub.
# No powershell updater/device process is created by this test.
$oldStartProcessFunction = Get-Item Function:Start-Process -ErrorAction SilentlyContinue
try {
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
        $script:spawnSawPossible = $script:possibleForTest
        if ($script:spawnTestMode -eq "throw") { throw "synthetic CreateProcess result unavailable" }
        return [pscustomobject]@{ Id = 0 }
    }
    foreach ($mode in @("throw", "unconfirmed-pid")) {
        $script:spawnTestMode = $mode
        $script:possibleForTest = $false
        $script:spawnSawPossible = $false
        $thrown = $false
        try {
            $null = Start-ArtemAutomaticUpdater -Paths ([pscustomobject]@{ UpdateScript="unused.ps1"; RepoRoot="unused" }) `
                -CurrentHead $previous -TargetHead $target -UpdateRequestId $request `
                -PossibleDispatch ([ref]$script:possibleForTest)
        } catch { $thrown = $true }
        $failure = Get-ArtemAutomaticFailureResult -PossibleDispatch $script:possibleForTest -TransactionStateKnownClear $true
        Assert-True ($thrown -and $script:spawnSawPossible -and $failure.status -eq "uncertain") "Ambiguous spawn must be marked before invocation and freeze replay"
    }
}
finally {
    Remove-Item Function:Start-Process -ErrorAction SilentlyContinue
    if ($null -ne $oldStartProcessFunction) { Set-Item Function:Start-Process -Value $oldStartProcessFunction.ScriptBlock }
}
# Real PS5.1 -> native Python argv smoke. setup-python owns PATH in CI.
$python = (Get-Command python -ErrorAction Stop).Source
. (Join-Path $PSScriptRoot "install-auto-deploy.ps1") -PythonPath $python -ConfigPath "not-read-in-contract-test" -ContractTest
$version = Get-ArtemStablePythonVersion -Executable $python
Assert-True ($version.major -eq 3 -and $version.minor -ge 9 -and -not $version.venv) "Stable native Python probe must survive PS5.1 argument quoting"

# Relocate the actual adapter away from the checkout. Get-ArtemRuntimePaths
# must retain runtime-common.ps1's lexical script root, not the adapter's root.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("artem-auto-deploy-contract-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    $relocated = Join-Path $tempRoot "stable adapter.ps1"
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "apply-automatic-update.ps1") -Destination $relocated
    $actual = . $relocated -RepoRoot $repo -ExpectedTargetHead $target -PathsContractTest
    Assert-True ($actual.RepoRoot -eq $repo) "Relocated adapter must resolve canonical checkout root"
    Assert-True ($actual.UpdateScript -eq (Join-Path $repo "scripts\windows\update-production.ps1")) "Relocated adapter must select canonical updater path"
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
Write-Output "Automatic deployment: 10 state, 4 preflight, 1 JSON-null, 2 spawn-boundary, 1 native Python and 2 relocated-path checks passed (20 total; no device IO)."

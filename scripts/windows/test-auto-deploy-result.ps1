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
Assert-True ($result.status -eq "failed_healthy" -and $result.code -eq 1) "Safe pre-cutover failure is not success"
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
Write-Output "Automatic deployment: 9 state checks, native Python probe, 2 relocated-path checks passed (no device IO)."

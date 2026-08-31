# Test-only semantic fixture for the deployed parent at
# a2b0eb4b241032eb3b8975a7c8fff24fc4966219. Keep this legacy: it must not
# publish the explicit ownerless handoff lease.
function Start-ArtemLegacyTargetContinuationFixture {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Current,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Target,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{24}$')][string]$LockRequestId,
        [Parameter(Mandatory)][string]$TargetScript
    )
    $targetScriptArgument = "`"$TargetScript`""
    return Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $targetScriptArgument,
        "-ExpectedCurrentHead", $Current, "-ExpectedTargetHead", $Target,
        "-RequestId", $LockRequestId, "-Continuation"
    ) -WorkingDirectory $Paths.RepoRoot -WindowStyle Hidden -Wait -PassThru
}

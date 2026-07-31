param(
    [ValidateSet("read_only", "standard", "full")]
    [string]$Profile = "standard"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
Update-ArtemProcessPath

$previousPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = Join-Path $paths.RepoRoot "apps\panel-agent\src"
    & $paths.Python -m panel_agent.access_setup --profile $Profile
    if ($LASTEXITCODE -ne 0) {
        throw "Access PIN configuration failed with exit code $LASTEXITCODE"
    }
}
finally {
    $env:PYTHONPATH = $previousPythonPath
}

$policyPath = Join-Path $paths.RuntimeRoot "access-policy.json"
$auditPath = Join-Path $paths.RuntimeRoot "audit"
New-Item -ItemType Directory -Force -Path $auditPath | Out-Null
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

& icacls.exe $policyPath `
    /inheritance:r `
    /grant:r `
    "*${currentUserSid}:(F)" `
    "*S-1-5-18:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict access-policy.json ACL"
}

& icacls.exe $auditPath `
    /inheritance:r `
    /grant:r `
    "*${currentUserSid}:(OI)(CI)(F)" `
    "*S-1-5-18:(OI)(CI)(F)" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict access audit directory ACL"
}

Write-Host "Access policy protected for the panel account and SYSTEM."

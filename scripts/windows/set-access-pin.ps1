param(
    [ValidateSet("read_only", "standard", "full")]
    [string]$Profile = "standard",
    [switch]$SkipRuntimeRestart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

function Set-RuntimeEnvEntry {
    param(
        [Parameter(Mandatory)][System.Collections.Generic.List[string]]$Lines,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Value
    )

    $pattern = "^\s*" + [regex]::Escape($Key) + "\s*="
    $found = $false
    for ($index = $Lines.Count - 1; $index -ge 0; $index--) {
        if ($Lines[$index] -match $pattern) {
            if (-not $found) {
                $Lines[$index] = "$Key=$Value"
                $found = $true
            }
            else {
                $Lines.RemoveAt($index)
            }
        }
    }
    if (-not $found) {
        $Lines.Add("$Key=$Value")
    }
}

function Protect-ArtemFile {
    param([Parameter(Mandatory)][string]$Path)

    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path `
        /inheritance:r `
        /grant:r `
        "*${currentUserSid}:(F)" `
        "*S-1-5-18:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict ACL for $Path"
    }
}

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
Protect-ArtemFile -Path $policyPath

$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $auditPath `
    /inheritance:r `
    /grant:r `
    "*${currentUserSid}:(OI)(CI)(F)" `
    "*S-1-5-18:(OI)(CI)(F)" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict access audit directory ACL"
}

if (-not (Test-Path -LiteralPath $paths.RuntimeEnv)) {
    throw "runtime.env is missing. Install the production runtime first."
}

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in (Get-Content -LiteralPath $paths.RuntimeEnv)) {
    $lines.Add([string]$line)
}

# Standard capabilities are protected by AccessPolicyMiddleware. These transport
# gates must be enabled as well, otherwise a valid standard/full profile still
# produces permanently disabled controls and can never reach the access layer.
$standardGates = [ordered]@{
    PANEL_WRITES_ENABLED = "true"
    PANEL_COFFEE_ACTIONS_ENABLED = "true"
    PANEL_COFFEE_TIMING_WRITES_ENABLED = "true"
    PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED = "true"
}
foreach ($entry in $standardGates.GetEnumerator()) {
    Set-RuntimeEnvEntry -Lines $lines -Key ([string]$entry.Key) -Value ([string]$entry.Value)
}

$temporary = "$($paths.RuntimeEnv).$PID.tmp"
try {
    Set-Content -LiteralPath $temporary -Value $lines -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $paths.RuntimeEnv -Force
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
Protect-ArtemFile -Path $paths.RuntimeEnv

Write-Host "Access policy and standard action gates configured."
Write-Host "Coffee control, timing and notification writes are now governed by the selected access profile."

if (-not $SkipRuntimeRestart) {
    Stop-ArtemRuntime -Paths $paths -Manual $false
    Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
    & $paths.StartScript
    if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
        throw "Control Center did not become ready after access configuration"
    }
    Write-Host "Control Center restarted with the updated action gates."
}

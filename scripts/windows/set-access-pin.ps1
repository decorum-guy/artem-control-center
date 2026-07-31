param(
    [ValidateSet("read_only", "standard", "full")]
    [string]$Profile = "standard",
    [switch]$SkipRuntimeRestart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$script:RuntimeEnvLines = [System.Collections.Generic.List[string]]::new()

function Set-RuntimeEnvEntry {
    param(
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Value
    )

    $pattern = "^\s*" + [regex]::Escape($Key) + "\s*="
    $found = $false
    for ($index = $script:RuntimeEnvLines.Count - 1; $index -ge 0; $index--) {
        if ($script:RuntimeEnvLines[$index] -match $pattern) {
            if (-not $found) {
                $script:RuntimeEnvLines[$index] = "$Key=$Value"
                $found = $true
            }
            else {
                $script:RuntimeEnvLines.RemoveAt($index)
            }
        }
    }
    if (-not $found) {
        [void]$script:RuntimeEnvLines.Add("$Key=$Value")
    }
}

function Get-RuntimeEnvEntry {
    param([Parameter(Mandatory)][string]$Key)

    $pattern = "^\s*" + [regex]::Escape($Key) + "\s*=\s*(.*)$"
    for ($index = $script:RuntimeEnvLines.Count - 1; $index -ge 0; $index--) {
        $match = [regex]::Match($script:RuntimeEnvLines[$index], $pattern)
        if ($match.Success) {
            return $match.Groups[1].Value.Trim()
        }
    }
    return ""
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

if (-not (Test-Path -LiteralPath $paths.RuntimeEnv)) {
    throw "runtime.env is missing. Install the production runtime first."
}
foreach ($line in (Get-Content -LiteralPath $paths.RuntimeEnv)) {
    [void]$script:RuntimeEnvLines.Add([string]$line)
}

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

$mode = Get-RuntimeEnvEntry -Key "PANEL_AGENT_MODE"
if (-not $mode) {
    $mode = "fixtures"
}
$requiredCoffeeEntries = @(
    "PANEL_HA_URL",
    "PANEL_HA_TOKEN",
    "PANEL_ALICE_BASE_URL",
    "PANEL_ALICE_CONTROL_CENTER_TOKEN"
)
$missingCoffeeEntries = @(
    $requiredCoffeeEntries |
        Where-Object { -not (Get-RuntimeEnvEntry -Key $_) }
)
$coffeeTransportReady = (
    $mode -eq "production" -and
    $missingCoffeeEntries.Count -eq 0
)
$coffeeGateValue = if ($coffeeTransportReady) { "true" } else { "false" }

# Fixture writes are always an explicit development-only opt-in. A production
# kiosk must never report a simulated state change as physical confirmation.
Set-RuntimeEnvEntry -Key "PANEL_FIXTURE_WRITES_ENABLED" -Value "false"
Set-RuntimeEnvEntry -Key "PANEL_COFFEE_ACTIONS_ENABLED" -Value $coffeeGateValue
Set-RuntimeEnvEntry -Key "PANEL_COFFEE_TIMING_WRITES_ENABLED" -Value $coffeeGateValue
Set-RuntimeEnvEntry -Key "PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED" -Value $coffeeGateValue
if ($coffeeTransportReady) {
    Set-RuntimeEnvEntry -Key "PANEL_WRITES_ENABLED" -Value "true"
}

$temporary = "$($paths.RuntimeEnv).$PID.tmp"
try {
    Set-Content -LiteralPath $temporary -Value $script:RuntimeEnvLines -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $paths.RuntimeEnv -Force
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
Protect-ArtemFile -Path $paths.RuntimeEnv

Write-Host "Access policy configured and protected."
if ($coffeeTransportReady) {
    Write-Host "Production coffee control, timing and notification gates are enabled."
}
else {
    Write-Warning "Coffee mutation gates remain disabled because the production transport is not ready."
    Write-Host "  PANEL_AGENT_MODE: $mode"
    if ($missingCoffeeEntries.Count -gt 0) {
        Write-Host "  Missing configuration: $($missingCoffeeEntries -join ', ')"
    }
    Write-Host "No simulated fixture command can be presented as a physical device confirmation."
}

if (-not $SkipRuntimeRestart) {
    Stop-ArtemRuntime -Paths $paths -Manual $false
    Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
    & $paths.StartScript
    if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
        throw "Control Center did not become ready after access configuration"
    }
    Write-Host "Control Center restarted with the updated access policy."
}

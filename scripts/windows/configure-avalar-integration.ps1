param(
    [string]$MainUrl = "https://avalar.pro",
    [string]$StageUrl = "https://stage.avalar.pro",
    [string]$StatusSshHost = "avalar-status",
    [string]$ActionSshHost = "avalar-control",
    [switch]$EnableStageMutations,
    [switch]$EnableMainRestart,
    [switch]$EnableMainDeploy,
    [switch]$RestartRuntime
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$script:RuntimeEnvLines = [System.Collections.Generic.List[string]]::new()

function ConvertTo-EnvBool {
    param([bool]$Value)
    if ($Value) { return "true" }
    return "false"
}

function Set-EnvEntry {
    param(
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Value
    )
    if ($Key -notmatch '^[A-Z_][A-Z0-9_]*$') {
        throw "Invalid environment key: $Key"
    }
    if ($Value -match "[`r`n]") {
        throw "Environment values must be single-line"
    }

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

function Protect-RuntimeFile {
    param([Parameter(Mandatory)][string]$Path)
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path `
        /inheritance:r `
        /grant:r `
        "*${currentUserSid}:(F)" `
        "*S-1-5-18:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict runtime configuration ACL"
    }
}

foreach ($url in @($MainUrl, $StageUrl)) {
    $parsed = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsed)) {
        throw "Invalid AVALAR URL: $url"
    }
    if ($parsed.Scheme -ne "https" -or $parsed.Query -or $parsed.Fragment) {
        throw "AVALAR URLs must be clean HTTPS base URLs"
    }
}
foreach ($hostAlias in @($StatusSshHost, $ActionSshHost)) {
    if ($hostAlias -notmatch '^[A-Za-z0-9._@-]+$') {
        throw "Invalid SSH alias: $hostAlias"
    }
}

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
if (-not (Test-Path -LiteralPath $paths.RuntimeEnv)) {
    throw "runtime.env is missing. Install the production runtime first."
}

foreach ($line in (Get-Content -LiteralPath $paths.RuntimeEnv)) {
    [void]$script:RuntimeEnvLines.Add([string]$line)
}
if (
    $script:RuntimeEnvLines.Count -gt 0 -and
    $script:RuntimeEnvLines[$script:RuntimeEnvLines.Count - 1] -ne ""
) {
    [void]$script:RuntimeEnvLines.Add("")
}

$entries = [ordered]@{
    PANEL_AGENT_MODE = "production"
    PANEL_AVALAR_MAIN_URL = $MainUrl.TrimEnd('/')
    PANEL_AVALAR_STAGE_URL = $StageUrl.TrimEnd('/')
    PANEL_AVALAR_SSH_ENABLED = "true"
    PANEL_AVALAR_SSH_HOST = $StatusSshHost
    PANEL_AVALAR_SSH_STATUS_COMMAND = "control-center"
    PANEL_AVALAR_ACTIONS_ENABLED = "true"
    PANEL_AVALAR_ACTION_SSH_HOST = $ActionSshHost
    PANEL_AVALAR_ACTION_COMMAND = "control-center"
    PANEL_AVALAR_SMOKE_ENABLED = "true"
    PANEL_AVALAR_STAGE_RESTART_ENABLED = (ConvertTo-EnvBool -Value $EnableStageMutations.IsPresent)
    PANEL_AVALAR_STAGE_DEPLOY_ENABLED = (ConvertTo-EnvBool -Value $EnableStageMutations.IsPresent)
    PANEL_AVALAR_MAIN_RESTART_ENABLED = (ConvertTo-EnvBool -Value $EnableMainRestart.IsPresent)
    PANEL_AVALAR_MAIN_DEPLOY_ENABLED = (ConvertTo-EnvBool -Value $EnableMainDeploy.IsPresent)
    PANEL_WRITES_ENABLED = "true"
}

foreach ($entry in $entries.GetEnumerator()) {
    Set-EnvEntry -Key $entry.Key -Value ([string]$entry.Value)
}

$temporary = "$($paths.RuntimeEnv).$PID.tmp"
try {
    Set-Content -LiteralPath $temporary -Value $script:RuntimeEnvLines -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $paths.RuntimeEnv -Force
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
Protect-RuntimeFile -Path $paths.RuntimeEnv

Write-Host "AVALAR integration configuration updated."
Write-Host "  Main: $($entries.PANEL_AVALAR_MAIN_URL)"
Write-Host "  Stage: $($entries.PANEL_AVALAR_STAGE_URL)"
Write-Host "  Status SSH alias: $StatusSshHost"
Write-Host "  Action SSH alias: $ActionSshHost"
Write-Host "  Smoke: enabled"
Write-Host "  Stage restart/deploy: $($entries.PANEL_AVALAR_STAGE_RESTART_ENABLED)"
Write-Host "  Main restart: $($entries.PANEL_AVALAR_MAIN_RESTART_ENABLED)"
Write-Host "  Main deploy: $($entries.PANEL_AVALAR_MAIN_DEPLOY_ENABLED)"
Write-Host "Runtime configuration ACL reapplied."

if ($RestartRuntime) {
    Stop-ArtemRuntime -Paths $paths -Manual $false
    Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
    & $paths.StartScript
    if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
        throw "Control Center did not become ready after AVALAR configuration"
    }
    Write-Host "Control Center restarted with the new integration configuration."
}

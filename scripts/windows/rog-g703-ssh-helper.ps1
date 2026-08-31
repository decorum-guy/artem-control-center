[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("health", "sleep", "hibernate")]
    [string]$Operation,
    [Parameter(DontShow = $true)]
    [switch]$ExecuteTransition
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$transitionDelayMilliseconds = 1200

if ($args.Count -ne 0) {
    exit 64
}

function Write-StrictJson {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Payload)
    [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

function Invoke-RealWindowsSleep {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ArtemRogPowerTransition {
    [DllImport("powrprof.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
}
'@
    if (-not [ArtemRogPowerTransition]::SetSuspendState($false, $true, $false)) {
        throw "Windows Sleep transition was rejected."
    }
}

function Invoke-FixedTransition {
    param([Parameter(Mandatory = $true)][string]$TransitionOperation)
    Start-Sleep -Milliseconds $transitionDelayMilliseconds
    if ($TransitionOperation -eq "sleep") {
        # FALSE requests suspend/Sleep and never selects hibernation.
        Invoke-RealWindowsSleep
        return
    }
    if ($TransitionOperation -eq "hibernate") {
        & "$env:SystemRoot\System32\shutdown.exe" /h
        if ($LASTEXITCODE -ne 0) {
            throw "Windows Hibernate transition was rejected."
        }
        return
    }
    exit 64
}

function Start-FixedDetachedTransition {
    param([Parameter(Mandatory = $true)][ValidateSet("sleep", "hibernate")][string]$TransitionOperation)
    $powerShellPath = Join-Path $PSHOME "powershell.exe"
    Start-Process `
        -FilePath $powerShellPath `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath, "-Operation", $TransitionOperation, "-ExecuteTransition") `
        -WindowStyle Hidden | Out-Null
}

if ($ExecuteTransition) {
    if ($Operation -eq "health") {
        exit 64
    }
    Invoke-FixedTransition -TransitionOperation $Operation
    exit 0
}

if ($Operation -eq "health") {
    Write-StrictJson ([ordered]@{
        schemaVersion = 1
        ok = $true
        status = "online"
    })
    exit 0
}

# The child starts its fixed delayed transition before this helper acknowledges.
# Its bounded delay gives SSH stdout time to flush and this process time to exit.
Start-FixedDetachedTransition -TransitionOperation $Operation
Write-StrictJson ([ordered]@{
    schemaVersion = 1
    accepted = $true
    operation = $Operation
})
exit 0

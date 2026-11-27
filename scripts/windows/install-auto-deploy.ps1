param(
    [Parameter(Mandatory)][string]$PythonPath,
    [Parameter(Mandatory)][string]$ConfigPath,
    [switch]$Enable,
    [switch]$ContractTest
)
function Get-ArtemStablePythonVersion {
    param([Parameter(Mandatory)][string]$Executable)
    # No quotes inside the native -c argument: Windows PowerShell 5.1 strips
    # nested unescaped double quotes when constructing native command lines.
    $probe = & $Executable -I -c 'import sys; print(sys.version_info.major, sys.version_info.minor, int(sys.prefix != sys.base_prefix))'
    if ($LASTEXITCODE -ne 0 -or [string]$probe -notmatch '^[0-9]+ [0-9]+ [01]$') { throw "Cannot validate stable Python" }
    $fields = ([string]$probe).Trim() -split '\s+'
    $version = [pscustomobject]@{ major=[int]$fields[0]; minor=[int]$fields[1]; venv=([int]$fields[2] -eq 1) }
    if ($version.major -ne 3 -or $version.minor -lt 9 -or $version.venv) { throw "Choose stable system Python 3.9+ outside any venv" }
    return $version
}

# Loads the actual native Python probe without reading config, changing ACLs or
# registering a task. The Windows regression executes it under PowerShell 5.1.
if ($ContractTest) { return }

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$python = (Resolve-Path -LiteralPath $PythonPath).Path
$configFile = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$stateRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "ArtemControlCenterAutoDeploy"))
$agentRoot = Join-Path $stateRoot "agent"
$worker = Join-Path $agentRoot "auto_deploy.py"
$adapter = Join-Path $agentRoot "apply-automatic-update.ps1"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$allowedSids = @($sid, "S-1-5-18", "S-1-5-32-544")

function Assert-ProtectedChild {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($stateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Config and token must be files inside the dedicated auto-deploy directory"
    }
    $cursor = $full
    while ($cursor -and $cursor.Length -ge $stateRoot.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse paths are not permitted for auto-deploy state" }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

function Set-PrivateAcl {
    param([string]$Path, [bool]$Directory)
    # Build a new DACL: changing inheritance/grant alone leaves old explicit
    # Users ACEs intact. Current owner, SYSTEM and Administrators are deliberate.
    $acl = if ($Directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in $allowedSids) {
        $principal = [System.Security.Principal.SecurityIdentifier]::new($id)
        $inherit = if ($Directory) { [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit" } else { [System.Security.AccessControl.InheritanceFlags]::None }
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    $actual = Get-Acl -LiteralPath $Path
    $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 3) { throw "Private ACL verification failed" }
    foreach ($rule in $rules) {
        if ($allowedSids -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
            throw "Unexpected auto-deploy ACL entry"
        }
    }
}

if ($config.schemaVersion -ne 1 -or @($config.targets).Count -ne 1 -or $config.targets[0].id -ne "panel") { throw "Use a dedicated Samsung panel config" }
if ([IO.Path]::GetFullPath([string]$config.state_directory) -ne $stateRoot) { throw "State directory must be the dedicated LOCALAPPDATA auto-deploy directory" }
if ([IO.Path]::GetFullPath([string]$config.targets[0].checkout) -ne $repoRoot) { throw "Checkout path mismatch" }
if ([IO.Path]::GetFullPath([string]$config.targets[0].adapter) -ne $adapter) { throw "Adapter path must be the stable installed copy" }
if ([bool]$config.targets[0].enabled -ne [bool]$Enable) { throw "Config enabled flag must match explicit -Enable" }
Assert-ProtectedChild -Path $configFile
Assert-ProtectedChild -Path ([string]$config.github_token_file)
Assert-ProtectedChild -Path $worker
Assert-ProtectedChild -Path $adapter
if ($python.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Choose a stable system Python outside the checkout" }
$null = Get-ArtemStablePythonVersion -Executable $python
$existing = Get-ScheduledTask -TaskName "Artem Control Center Auto Deploy" -ErrorAction SilentlyContinue
if ($null -ne $existing -and [string]$existing.State -eq "Running") { throw "Wait for the current worker transaction before replacing its code" }
New-Item -ItemType Directory -Force -Path $stateRoot, $agentRoot | Out-Null
Set-PrivateAcl -Path $stateRoot -Directory $true
Set-PrivateAcl -Path $agentRoot -Directory $true
foreach ($file in @($configFile, [string]$config.github_token_file)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required protected file missing" }
    Set-PrivateAcl -Path $file -Directory $false
}
Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\auto-deploy\auto_deploy.py") -Destination "$worker.new" -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "apply-automatic-update.ps1") -Destination "$adapter.new" -Force
Move-Item -LiteralPath "$worker.new" -Destination $worker -Force
Move-Item -LiteralPath "$adapter.new" -Destination $adapter -Force
Set-PrivateAcl -Path $worker -Directory $false
Set-PrivateAcl -Path $adapter -Directory $false
$arguments = '"{0}" reconcile --config "{1}"' -f $worker, $configFile
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $agentRoot
$timer = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $sid
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 40) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Trigger @($timer, $logon) -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName "Artem Control Center Auto Deploy" -InputObject $task -Force | Out-Null
if (-not $Enable) { Disable-ScheduledTask -TaskName "Artem Control Center Auto Deploy" | Out-Null }
Write-Output "Auto-deploy task installed; enabled=$([bool]$Enable). No deployment was started by the installer."

$ErrorActionPreference = "Stop"

$files = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.ps1" -File |
    Where-Object { $_.Name -ne "test-production-scripts.ps1" }

foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors
    )
    if ($errors.Count -gt 0) {
        $messages = $errors | ForEach-Object {
            "$($file.Name):$($_.Extent.StartLineNumber): $($_.Message)"
        }
        throw ($messages -join [Environment]::NewLine)
    }
}

$temporary = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("artem-runtime-acl-{0}.env" -f [guid]::NewGuid())

try {
    Set-Content -LiteralPath $temporary -Value "PANEL_AGENT_MODE=fixtures" -Encoding ASCII
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $aclArguments = @(
        $temporary,
        "/inheritance:r",
        "/grant:r",
        "*${currentUserSid}:(F)",
        "*S-1-5-18:(F)"
    )
    & icacls.exe @aclArguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "icacls rejected the production runtime ACL arguments"
    }

    $acl = Get-Acl -LiteralPath $temporary
    if (-not $acl.AreAccessRulesProtected) {
        throw "runtime.env ACL inheritance was not disabled"
    }

    $rules = $acl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    )
    $allowedFullControlSids = @(
        $rules |
            Where-Object {
                $_.AccessControlType -eq "Allow" -and
                ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl)
            } |
            ForEach-Object { $_.IdentityReference.Value }
    )

    foreach ($requiredSid in @($currentUserSid, "S-1-5-18")) {
        if ($requiredSid -notin $allowedFullControlSids) {
            throw "Required SID is missing FullControl on runtime.env: $requiredSid"
        }
    }

    # Build the same Task Scheduler objects as the installer. This catches local
    # account resolution regressions such as USERDOMAIN being exposed as WORKGROUP.
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUserSid
    $taskPrincipal = New-ScheduledTaskPrincipal `
        -UserId $currentUserSid `
        -LogonType Interactive `
        -RunLevel Limited
    if ($null -eq $taskTrigger -or $null -eq $taskPrincipal) {
        throw "Unable to construct Scheduled Task objects for the current user SID"
    }

    $installerText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "install-production.ps1") `
        -Raw
    if ($installerText -match '\$env:USERDOMAIN') {
        throw "Production installer must not derive the Scheduled Task account from USERDOMAIN"
    }
    if ($installerText -notmatch '\$userId\s*=\s*\$currentUserSid') {
        throw "Production installer must register the Scheduled Task with the resolved user SID"
    }
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated $($files.Count) Windows PowerShell scripts, runtime.env ACL and Scheduled Task SID handling."

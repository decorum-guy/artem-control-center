$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "runtime-common.ps1")

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
$rolloutRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("artem-avalar-rollout-{0}" -f [guid]::NewGuid())
$knowledgeContractRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("artem-knowledge-contract-{0}" -f [guid]::NewGuid())
$previousLocalAppData = $env:LOCALAPPDATA

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
    $syncHelpersText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "sync-desktop-helpers.ps1") `
        -Raw
    $runtimeCommonText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "runtime-common.ps1") `
        -Raw
    $startText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "start-production.ps1") `
        -Raw
    $openText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "open-kiosk.ps1") `
        -Raw
    $updaterText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "update-production.ps1") `
        -Raw
    $kioskPresenceText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "kiosk-presence.ps1") `
        -Raw

    if ($installerText -notmatch 'npm\.cmd[\s\S]*?build:production') {
        throw "Production installer must use the deterministic accepted V2 build profile"
    }
    if ($updaterText -notmatch 'npm\.cmd[\s\S]*?build:production') {
        throw "Production updater must rebuild the dashboard with the deterministic accepted V2 profile"
    }
    if ($installerText -match '\$env:USERDOMAIN') {
        throw "Production installer must not derive the Scheduled Task account from USERDOMAIN"
    }
    if ($installerText -notmatch '\$userId\s*=\s*\$currentUserSid') {
        throw "Production installer must register the Scheduled Task with the resolved user SID"
    }

    if ($runtimeCommonText -notmatch 'function Get-ArtemKioskProcesses') {
        throw "Kiosk process matching must be centralized"
    }
    if ($runtimeCommonText -notmatch '\$\(\$Paths\.EdgeProfile\)') {
        throw "Kiosk process matching must require the dedicated Edge profile"
    }
    if ($runtimeCommonText -match 'CommandLine\s+-like\s+"\*--kiosk\*"') {
        throw "Kiosk shutdown must not depend on the transient --kiosk flag"
    }
    if ($runtimeCommonText -match 'Get-ArtemVisibleKioskProcesses') {
        throw "Kiosk status must not use deprecated desktop-window detection"
    }
    if ($runtimeCommonText -match '(?i)HWND|MainWindowHandle' -or $kioskPresenceText -match '(?i)HWND|MainWindowHandle') {
        throw "Kiosk ownership and visibility must not use HWND/MainWindowHandle detection"
    }
    if ($kioskPresenceText -notmatch '(?m)^function Ensure-ArtemKioskVisible\b') {
        throw "Visible kiosk restoration must use the canonical kiosk-presence helper"
    }
    if (([regex]::Matches($kioskPresenceText, '(?m)^function Ensure-ArtemKioskVisible\b')).Count -ne 1) {
        throw "Kiosk presence must contain exactly one canonical visibility/restoration helper"
    }
    if ($runtimeCommonText -match '(?m)^function Ensure-ArtemKioskVisible\b') {
        throw "Visible kiosk restoration must not have a second runtime-common implementation"
    }
    if ($runtimeCommonText -notmatch '\.\s+\$kioskPresenceScript') {
        throw "runtime-common must source kiosk-presence.ps1"
    }
    if ($kioskPresenceText -notmatch 'Stop-ArtemKiosk[\s\S]*?Start-Process') {
        throw "Stale/background panel Edge must be cleared before relaunching the kiosk"
    }
    if ($openText -notmatch 'Ensure-ArtemKioskVisible') {
        throw "Open must prove that a visible kiosk exists"
    }

    if ($startText -notmatch 'Wait-ArtemPanelReady\s+-Paths\s+\$paths\s+-TimeoutSeconds\s+20') {
        throw "Existing runtime must receive a bounded readiness recovery grace window"
    }
    if ($startText -notmatch 'Test-ArtemCapabilityApplyActive') {
        throw "Open recovery must protect a legitimate capability Apply"
    }
    if ($startText -notmatch 'Get-ArtemSoftwareUpdateLock') {
        throw "Open must not compete with an active software update"
    }
    if ($startText -notmatch 'Stop-ArtemRuntime\s+-Paths\s+\$paths\s+-Manual:\$false') {
        throw "Automatic unhealthy-runtime recovery must remain non-manual"
    }
    if ($startText -notmatch '-not\s+\$UpdateRequestId') {
        throw "Updater-owned restart must bypass the Scheduled Task path so its update lock identity is preserved"
    }

    foreach ($helperText in @($installerText, $syncHelpersText)) {
        if ($helperText -notmatch 'set "exitCode=%ERRORLEVEL%"') {
            throw "Open Control Center.cmd must preserve the PowerShell exit code"
        }
        if ($helperText -notmatch 'if not "%exitCode%"=="0"') {
            throw "Open Control Center.cmd must expose non-zero failures"
        }
        if ($helperText -notmatch 'pause') {
            throw "Open Control Center.cmd must pause after a real failure"
        }
        if ($helperText -notmatch 'exit /b %exitCode%') {
            throw "Open Control Center.cmd must return the original PowerShell exit code"
        }
    }

    foreach ($parameter in @('ExpectedCurrentHead', 'ExpectedTargetHead', 'RequestId')) {
        if ($updaterText -notmatch $parameter) {
            throw "Updater is missing exact-target handoff field: $parameter"
        }
    }
    if ($updaterText -notmatch 'git\.exe[\s\S]*?fetch[\s\S]*?origin[\s\S]*?main') {
        throw "Updater must re-fetch the canonical origin/main before shutdown"
    }
    if ($updaterText -notmatch '\$currentHead\s+-ne\s+\$ExpectedCurrentHead[\s\S]*?\$targetHead\s+-ne\s+\$ExpectedTargetHead') {
        throw "Updater must reject an exact-target mismatch before production shutdown"
    }
    if ($updaterText -notmatch '\$transactionStarted\s*=\s*\$true[\s\S]*?Stop-ArtemRuntime') {
        throw "Updater rollback ownership must begin only when the production transaction starts"
    }
    if ($updaterText -notmatch 'merge[\s\S]*?--ff-only[\s\S]*?\$targetHead') {
        throw "Updater must merge the exact checked target rather than a moving branch ref"
    }
    if (($updaterText | Select-String -Pattern 'Ensure-ArtemHealthyVisiblePanel' -AllMatches).Matches.Count -lt 4) {
        throw "No-op, success and rollback updater paths must all restore a healthy visible panel"
    }
    if ($updaterText -notmatch 'Test-ArtemCapabilityApplyActive') {
        throw "Software updater must not start during capability Apply"
    }
    if ($updaterText -notmatch 'New-ArtemUpdateLock') {
        throw "Software updater must serialize concurrent update transactions"
    }
    if ($updaterText -notmatch '\$Continuation' -or $updaterText -notmatch 'Assert-ArtemTargetUpdaterLogic') {
        throw "Updater must hand off target-dependent work to an explicit target continuation"
    }
    if ($updaterText -notmatch 'UpdateTransactionState' -or $updaterText -notmatch 'Assert-ArtemProductionBuildIdentity') {
        throw "Updater must persist incomplete state and assert production artifact identity"
    }

    $watcherText = Get-Content `
        -LiteralPath (Join-Path $PSScriptRoot "watch-kiosk.ps1") `
        -Raw
    if ($watcherText -notmatch 'Invoke-ArtemKioskWatcherLoop') {
        throw "Kiosk watcher entrypoint must delegate to the shared watcher loop"
    }
    if ($kioskPresenceText -notmatch 'ManualStop' -or $kioskPresenceText -notmatch 'Stop-ArtemKiosk') {
        throw "Kiosk watcher must close the dedicated profile after manual shutdown"
    }
    if ($kioskPresenceText -notmatch 'kiosk-watcher-owner' -or $watcherText -notmatch 'presence') {
        throw "Kiosk watcher must stay non-destructive on presence loss and honor single-owner supersession"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "test-kiosk-watcher.ps1"))) {
        throw "Deterministic kiosk watcher regression must exist beside the watcher policy"
    }

    if ($runtimeCommonText -notmatch 'Knowledge\s*=\s*Join-Path \$runtimeRoot "knowledge"') {
        throw "Runtime path contract must expose the knowledge directory beneath RuntimeRoot"
    }

    # Exercise the knowledge path and initialization contract against an
    # isolated LOCALAPPDATA. Initialization may create the directory, but it
    # must never own or rewrite the owner-maintained file.
    $env:LOCALAPPDATA = $knowledgeContractRoot
    $knowledgePaths = Get-ArtemRuntimePaths
    $expectedKnowledgeRuntimeRoot = Join-Path $knowledgeContractRoot "ArtemControlCenter"
    $expectedKnowledgeRoot = Join-Path $expectedKnowledgeRuntimeRoot "knowledge"
    if ($knowledgePaths.RuntimeRoot -ne $expectedKnowledgeRuntimeRoot) {
        throw "RuntimeRoot no longer follows %LOCALAPPDATA%\\ArtemControlCenter"
    }
    if ($knowledgePaths.Knowledge -ne $expectedKnowledgeRoot) {
        throw "Knowledge path is not beneath RuntimeRoot"
    }
    $repoRootFull = [IO.Path]::GetFullPath($knowledgePaths.RepoRoot)
    $knowledgeRootFull = [IO.Path]::GetFullPath($knowledgePaths.Knowledge)
    if ($knowledgeRootFull.StartsWith(
            $repoRootFull + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Knowledge path must remain outside RepoRoot"
    }

    Initialize-ArtemRuntimeDirectories -Paths $knowledgePaths
    if (-not (Test-Path -LiteralPath $knowledgePaths.Knowledge -PathType Container)) {
        throw "Runtime initialization did not create the knowledge directory"
    }
    $knowledgeFixture = Join-Path $knowledgePaths.Knowledge "coffee-guide.md"
    [IO.File]::WriteAllBytes(
        $knowledgeFixture,
        [Text.Encoding]::UTF8.GetBytes("# deterministic fixture`n")
    )
    $knowledgeBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($knowledgeFixture))
    Initialize-ArtemRuntimeDirectories -Paths $knowledgePaths
    $knowledgeAfter = [Convert]::ToBase64String([IO.File]::ReadAllBytes($knowledgeFixture))
    if ($knowledgeBefore -ne $knowledgeAfter) {
        throw "Runtime directory initialization overwrote coffee-guide.md"
    }

    # The real production promotion helper only owns generated dashboard
    # paths. Prove that a promotion leaves the knowledge fixture untouched and
    # keep a source guard for both promotion and updater/rollback ownership.
    $promotionRoot = Join-Path $knowledgeContractRoot "promotion"
    $promotionDashboard = Join-Path $promotionRoot "dashboard"
    $promotionStaged = Join-Path $promotionRoot "staged"
    New-Item -ItemType Directory -Force -Path $promotionDashboard, $promotionStaged | Out-Null
    Set-Content -LiteralPath (Join-Path $promotionDashboard "index.html") -Value "old" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $promotionStaged "index.html") -Value "new" -Encoding UTF8
    $promotionPaths = [pscustomobject]@{
        DashboardDist = $promotionDashboard
        RollbackDashboard = Join-Path $promotionRoot "rollback"
    }
    Promote-ArtemProductionBuild -Paths $promotionPaths -StagedDashboard $promotionStaged
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($knowledgeFixture)) -ne $knowledgeBefore) {
        throw "Production dashboard promotion changed coffee-guide.md"
    }
    $promotionFunction = $runtimeCommonText.Substring(
        $runtimeCommonText.IndexOf("function Promote-ArtemProductionBuild")
    )
    if ($promotionFunction -match '\$Paths\.Knowledge') {
        throw "Dashboard promotion must not own Knowledge"
    }
    if ($updaterText -match '(?im)(?:Move|Remove)-Item[^\r\n]*\$paths\.Knowledge') {
        throw "Updater and rollback must not own Knowledge"
    }

    # Exercise the real AVALAR runtime.env updater against an isolated LOCALAPPDATA.
    $env:LOCALAPPDATA = $rolloutRoot
    $runtimeRoot = Join-Path $rolloutRoot "ArtemControlCenter"
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    $runtimeEnv = Join-Path $runtimeRoot "runtime.env"
    @(
        "PANEL_AGENT_MODE=fixtures",
        "PANEL_AVALAR_MAIN_DEPLOY_ENABLED=true",
        "PANEL_AVALAR_MAIN_DEPLOY_ENABLED=true",
        "PANEL_COFFEE_ACTIONS_ENABLED=false"
    ) | Set-Content -LiteralPath $runtimeEnv -Encoding ASCII

    $configureAvalar = Join-Path $PSScriptRoot "configure-avalar-integration.ps1"
    & $configureAvalar
    $first = Get-Content -LiteralPath $runtimeEnv
    if (($first | Where-Object { $_ -eq "PANEL_AGENT_MODE=production" }).Count -ne 1) {
        throw "AVALAR rollout did not switch the production runtime mode"
    }
    if (($first | Where-Object { $_ -like "PANEL_AVALAR_MAIN_DEPLOY_ENABLED=*" }).Count -ne 1) {
        throw "AVALAR rollout did not remove duplicate gates"
    }
    foreach ($expected in @(
        "PANEL_AVALAR_SMOKE_ENABLED=true",
        "PANEL_AVALAR_STAGE_RESTART_ENABLED=false",
        "PANEL_AVALAR_STAGE_DEPLOY_ENABLED=false",
        "PANEL_AVALAR_MAIN_RESTART_ENABLED=false",
        "PANEL_AVALAR_MAIN_DEPLOY_ENABLED=false",
        "PANEL_COFFEE_ACTIONS_ENABLED=false"
    )) {
        if ($expected -notin $first) {
            throw "Safe AVALAR rollout value missing: $expected"
        }
    }

    & $configureAvalar -EnableStageMutations -EnableMainRestart
    $second = Get-Content -LiteralPath $runtimeEnv
    foreach ($expected in @(
        "PANEL_AVALAR_STAGE_RESTART_ENABLED=true",
        "PANEL_AVALAR_STAGE_DEPLOY_ENABLED=true",
        "PANEL_AVALAR_MAIN_RESTART_ENABLED=true",
        "PANEL_AVALAR_MAIN_DEPLOY_ENABLED=false"
    )) {
        if ($expected -notin $second) {
            throw "Explicit AVALAR rollout value missing: $expected"
        }
    }

    $rolloutAcl = Get-Acl -LiteralPath $runtimeEnv
    if (-not $rolloutAcl.AreAccessRulesProtected) {
        throw "AVALAR rollout must reapply protected runtime.env ACL"
    }
}
finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $rolloutRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $knowledgeContractRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated $($files.Count) Windows PowerShell scripts, runtime ACLs, knowledge path/init/promotion isolation, visible kiosk/open recovery, exact-target updater, Scheduled Task SID and AVALAR rollout configuration."

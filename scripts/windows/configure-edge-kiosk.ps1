$ErrorActionPreference = "Stop"

$policyPath = "HKCU:\Software\Policies\Microsoft\Edge"
New-Item -Path $policyPath -Force | Out-Null

New-ItemProperty `
    -Path $policyPath `
    -Name "VisualSearchEnabled" `
    -PropertyType DWord `
    -Value 0 `
    -Force | Out-Null

New-ItemProperty `
    -Path $policyPath `
    -Name "SearchForImageEnabled" `
    -PropertyType DWord `
    -Value 0 `
    -Force | Out-Null

Write-Host "Microsoft Edge kiosk policies configured for the current user."
Write-Host "Restart Edge to apply Visual Search changes."

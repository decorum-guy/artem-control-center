$ErrorActionPreference = "Stop"

$script:ArtemCoffeeUploadIngressFirewallRuleName = "Artem Control Center Coffee Upload Ingress"

function Get-ArtemCoffeeUploadIngressFirewallRuleName {
    return $script:ArtemCoffeeUploadIngressFirewallRuleName
}

function Assert-ArtemCoffeeUploadIngressPort {
    param([Parameter(Mandatory)][int]$Port)
    if ($Port -lt 1024 -or $Port -gt 65535 -or $Port -eq 8787) {
        throw "Coffee upload ingress port must be 1024-65535 and must not be 8787"
    }
}

function Remove-ArtemCoffeeUploadIngressFirewallRule {
    $name = Get-ArtemCoffeeUploadIngressFirewallRuleName
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

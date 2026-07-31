$ErrorActionPreference = "Stop"

function ConvertTo-ArtemNativeProcessArgument {
    param([AllowEmptyString()][Parameter(Mandatory)][string]$Value)

    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw "Native process arguments must not contain quotes or line breaks"
    }
    if ($Value.Length -eq 0) {
        return '""'
    }
    if ($Value -match '\s') {
        if ($Value.EndsWith('\')) {
            throw "Quoted native process arguments must not end with a backslash"
        }
        return '"' + $Value + '"'
    }
    return $Value
}

function Invoke-ArtemSshKeygen {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [AllowEmptyCollection()]
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    # Windows PowerShell 5.1 drops an empty native argument in a direct call such
    # as ssh-keygen -N "". Preserve every argument explicitly.
    if ($startInfo.PSObject.Properties.Name -contains "ArgumentList") {
        foreach ($argument in $Arguments) {
            [void]$startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $startInfo.Arguments = (
            $Arguments |
                ForEach-Object { ConvertTo-ArtemNativeProcessArgument -Value $_ }
        ) -join " "
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "ssh-keygen process did not start"
        }
        $standardOutput = $process.StandardOutput.ReadToEnd()
        $standardError = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $standardOutput
            StandardError = $standardError
        }
    }
    finally {
        $process.Dispose()
    }
}

function Ensure-ArtemEd25519Identity {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$KeyPath,
        [Parameter(Mandatory)][string]$Comment
    )

    $publicKeyPath = "$KeyPath.pub"
    if (Test-Path -LiteralPath $KeyPath) {
        if (-not (Test-Path -LiteralPath $publicKeyPath)) {
            throw "Private key exists but its public key is missing: $KeyPath"
        }
        return [pscustomobject]@{
            Created = $false
            PrivateKeyPath = $KeyPath
            PublicKeyPath = $publicKeyPath
        }
    }

    $result = Invoke-ArtemSshKeygen `
        -Executable $Executable `
        -Arguments @(
            "-q",
            "-t", "ed25519",
            "-f", $KeyPath,
            "-N", "",
            "-C", $Comment
        )
    if ($result.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $publicKeyPath)) {
        $diagnostic = $result.StandardError.Trim()
        if (-not $diagnostic) {
            $diagnostic = "ssh-keygen exited with code $($result.ExitCode)"
        }
        throw "Unable to generate SSH identity: $KeyPath. $diagnostic"
    }

    return [pscustomobject]@{
        Created = $true
        PrivateKeyPath = $KeyPath
        PublicKeyPath = $publicKeyPath
    }
}

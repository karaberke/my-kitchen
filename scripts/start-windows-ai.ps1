# Run from a hidden, current-user logon task. Keep this process running so Task
# Scheduler can restart it if llama-server exits. No prompts or answers are logged.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ServerPath,

    [Parameter(Mandatory = $true)]
    [string] $ModelPath,

    [Parameter(Mandatory = $true)]
    [string] $ListenAddress,

    [ValidatePattern('^[A-Za-z0-9_./:,\-]+$')]
    [string] $ModelAlias = 'assistant',

    [ValidateRange(1, 65535)]
    [int] $Port = 8080,

    [ValidateRange(512, 1048576)]
    [int] $ContextSize = 8192,

    [ValidatePattern('^[A-Za-z0-9_,.\-]+$')]
    [string] $Device = 'Vulkan1',

    [ValidateRange(0, 600)]
    [int] $AddressWaitSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$serviceMutex = $null
$ownsMutex = $false
$serverExitCode = 1

try {
    foreach ($filePath in @($ServerPath, $ModelPath)) {
        $absolutePath = $filePath -match '^[A-Za-z]:[\\/]' -or
            $filePath -match '^\\\\[^\\]+\\[^\\]+\\'
        if (-not $absolutePath -or
            -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            throw 'ServerPath and ModelPath must be existing absolute file paths.'
        }
    }
    $ServerPath = (Get-Item -LiteralPath $ServerPath).FullName
    $ModelPath = (Get-Item -LiteralPath $ModelPath).FullName
    if ([System.IO.Path]::GetExtension($ServerPath) -ine '.exe') {
        throw 'ServerPath must point to llama-server.exe.'
    }

    $bindAddress = $null
    if ($ListenAddress -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or
        -not [System.Net.IPAddress]::TryParse($ListenAddress, [ref] $bindAddress) -or
        $bindAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'ListenAddress must be a private or loopback IPv4 address.'
    }
    $octets = $bindAddress.GetAddressBytes()
    $privateAddress = $octets[0] -eq 127 -or $octets[0] -eq 10 -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168) -or
        ($octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127)
    if (-not $privateAddress) {
        throw 'Use a loopback, RFC 1918 LAN, or Tailscale IPv4 address.'
    }
    $ListenAddress = $bindAddress.ToString()

    $mutexName = 'Local\MyKitchenAI-' + $ListenAddress.Replace('.', '-') + '-' + $Port
    $serviceMutex = [System.Threading.Mutex]::new($false, $mutexName)
    try {
        $ownsMutex = $serviceMutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        exit 0
    }

    # Tailscale or the LAN adapter can appear after the logon task starts.
    $addressDeadline = [DateTime]::UtcNow.AddSeconds($AddressWaitSeconds)
    do {
        $addressReady = $false
        foreach ($networkInterface in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            foreach ($unicastAddress in $networkInterface.GetIPProperties().UnicastAddresses) {
                if ($unicastAddress.Address.Equals($bindAddress)) {
                    $addressReady = $true
                    break
                }
            }
            if ($addressReady) { break }
        }
        if ($addressReady) { break }
        if ([DateTime]::UtcNow -ge $addressDeadline) {
            throw 'The configured network address did not become available before the deadline.'
        }
        Start-Sleep -Seconds 2
    } while ($true)

    # Do not stop an existing service or an unrelated program occupying the port.
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach ($listener in $listeners) {
        if ($listener.Port -eq $Port -and
            ($listener.Address.Equals($bindAddress) -or
             $listener.Address.Equals([System.Net.IPAddress]::Any) -or
             $listener.Address.Equals([System.Net.IPAddress]::IPv6Any))) {
            throw 'The configured TCP port is already in use.'
        }
    }

    $gpuLayers = if ($Device -eq 'none') { '0' } else { '99' }
    $serverArguments = @(
        '--model', $ModelPath,
        '--host', $ListenAddress,
        '--port', $Port.ToString(),
        '--alias', $ModelAlias,
        '--ctx-size', $ContextSize.ToString(),
        '--parallel', '1',
        '--device', $Device,
        '--n-gpu-layers', $gpuLayers,
        '--offline',
        '--no-webui',
        '--no-slots',
        '--log-disable'
    )

    # Some native backends write startup output directly to stderr. Discard both
    # streams, including native errors, without persisting user-derived content.
    $ErrorActionPreference = 'Continue'
    & $ServerPath @serverArguments *> $null
    $serverExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($serverExitCode -ne 0) {
        throw 'llama-server exited unsuccessfully. Check the model, device, and available memory.'
    }
}
catch {
    # Only our own fixed diagnostic messages are written; native output is discarded.
    [Console]::Error.WriteLine('My Kitchen AI could not start. Check the launcher parameters, network, port, and available memory.')
    $serverExitCode = 1
}
finally {
    if ($ownsMutex) { $serviceMutex.ReleaseMutex() }
    if ($null -ne $serviceMutex) { $serviceMutex.Dispose() }
}

exit $serverExitCode

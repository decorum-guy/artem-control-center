param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("status", "set-volume", "set-brightness")]
    [string]$Action,

    [ValidateRange(0, 100)]
    [int]$Value = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Ensure-AudioType {
    if ("ArtemControlCenter.Audio.MasterVolume" -as [type]) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ArtemControlCenter.Audio
{
    internal enum EDataFlow
    {
        eRender = 0,
        eCapture = 1,
        eAll = 2
    }

    internal enum ERole
    {
        eConsole = 0,
        eMultimedia = 1,
        eCommunications = 2
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IntPtr ppDevices);

        [PreserveSig]
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);

        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);

        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr pClient);

        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig]
        int Activate(
            ref Guid iid,
            uint dwClsCtx,
            IntPtr pActivationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);

        [PreserveSig]
        int OpenPropertyStore(uint stgmAccess, out IntPtr ppProperties);

        [PreserveSig]
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);

        [PreserveSig]
        int GetState(out uint pdwState);
    }

    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int GetChannelCount(ref uint pnChannelCount);
        [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
        [PreserveSig] int GetMasterVolumeLevel(ref float pfLevelDB);
        [PreserveSig] int GetMasterVolumeLevelScalar(ref float pfLevel);
        [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint nChannel, ref float pfLevelDB);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, ref float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
        [PreserveSig] int GetMute(ref bool pbMute);
        [PreserveSig] int GetVolumeStepInfo(ref uint pnStep, ref uint pnStepCount);
        [PreserveSig] int VolumeStepUp(Guid pguidEventContext);
        [PreserveSig] int VolumeStepDown(Guid pguidEventContext);
        [PreserveSig] int QueryHardwareSupport(ref uint pdwHardwareSupportMask);
        [PreserveSig] int GetVolumeRange(ref float pflVolumeMindB, ref float pflVolumeMaxdB, ref float pflVolumeIncrementdB);
    }

    public static class MasterVolume
    {
        private const uint CLSCTX_ALL = 23;

        private static IAudioEndpointVolume OpenEndpoint()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device;
            Marshal.ThrowExceptionForHR(
                enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device));

            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object endpointObject;
            Marshal.ThrowExceptionForHR(
                device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out endpointObject));
            return (IAudioEndpointVolume)endpointObject;
        }

        public static int GetPercent()
        {
            IAudioEndpointVolume endpoint = OpenEndpoint();
            float scalar = 0.0f;
            Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(ref scalar));
            return Math.Max(0, Math.Min(100, (int)Math.Round(scalar * 100.0f)));
        }

        public static int SetPercent(int value)
        {
            IAudioEndpointVolume endpoint = OpenEndpoint();
            Guid context = Guid.Empty;
            float scalar = Math.Max(0, Math.Min(100, value)) / 100.0f;
            Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(scalar, context));
            return GetPercent();
        }
    }
}
'@
}

function New-State([bool]$Available, $CurrentValue, [string]$Reason = $null) {
    [ordered]@{
        available = $Available
        value = $CurrentValue
        reason = $Reason
    }
}

function Get-VolumeState {
    try {
        Ensure-AudioType
        $current = [ArtemControlCenter.Audio.MasterVolume]::GetPercent()
        return New-State $true ([int]$current)
    }
    catch {
        return New-State $false $null "unavailable"
    }
}

function Set-VolumeValue([int]$Target) {
    try {
        Ensure-AudioType
        [void][ArtemControlCenter.Audio.MasterVolume]::SetPercent($Target)
        return Get-VolumeState
    }
    catch {
        return New-State $false $null "unavailable"
    }
}

function Get-BrightnessState {
    try {
        $monitor = Get-CimInstance -Namespace "root/WMI" -ClassName "WmiMonitorBrightness" |
            Where-Object { $_.Active } |
            Select-Object -First 1
        if ($null -eq $monitor) {
            return New-State $false $null "unsupported"
        }
        return New-State $true ([int]$monitor.CurrentBrightness)
    }
    catch {
        return New-State $false $null "unavailable"
    }
}

function Set-BrightnessValue([int]$Target) {
    try {
        $method = Get-CimInstance -Namespace "root/WMI" -ClassName "WmiMonitorBrightnessMethods" |
            Where-Object { $_.Active } |
            Select-Object -First 1
        if ($null -eq $method) {
            return New-State $false $null "unsupported"
        }
        Invoke-CimMethod -InputObject $method -MethodName "WmiSetBrightness" -Arguments @{
            Timeout = [uint32]0
            Brightness = [byte]$Target
        } | Out-Null
        return Get-BrightnessState
    }
    catch {
        return New-State $false $null "unavailable"
    }
}

if ($Action -eq "set-volume") {
    $volume = Set-VolumeValue $Value
    $brightness = Get-BrightnessState
}
elseif ($Action -eq "set-brightness") {
    $volume = Get-VolumeState
    $brightness = Set-BrightnessValue $Value
}
else {
    $volume = Get-VolumeState
    $brightness = Get-BrightnessState
}

[ordered]@{
    schemaVersion = 1
    volume = $volume
    brightness = $brightness
} | ConvertTo-Json -Compress -Depth 4

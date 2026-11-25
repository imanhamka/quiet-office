using System.Diagnostics;
using System.Runtime.InteropServices;
using QuietOffice.Core;
using static QuietOffice.Native;

namespace QuietOffice;

/// <summary>Hidden top-level window that receives session lock, display power and Explorer restart
/// messages. It is not message-only (HWND_MESSAGE): those never get the TaskbarCreated broadcast.</summary>
internal sealed class SignalWindow : NativeWindow, IDisposable
{
    static readonly uint TaskbarCreated = RegisterWindowMessage("TaskbarCreated");
    readonly IntPtr powerHandle;
    public event Action<string, bool>? Reason;     // (reason, on)
    public event Action? ExplorerRestarted;

    public SignalWindow()
    {
        CreateHandle(new CreateParams { Caption = "QuietOffice.Signals" });
        WTSRegisterSessionNotification(Handle, 0 /* NOTIFY_FOR_THIS_SESSION */);
        var guid = GUID_CONSOLE_DISPLAY_STATE;
        powerHandle = RegisterPowerSettingNotification(Handle, ref guid, 0 /* DEVICE_NOTIFY_WINDOW_HANDLE */);
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case WM_WTSSESSION_CHANGE when (int)m.WParam is WTS_SESSION_LOCK or WTS_SESSION_UNLOCK:
                Reason?.Invoke("locked", (int)m.WParam == WTS_SESSION_LOCK);
                break;
            case WM_POWERBROADCAST:
                switch ((int)m.WParam)
                {
                    case PBT_APMSUSPEND: Reason?.Invoke("system-sleep", true); break;
                    case PBT_APMRESUMEAUTOMATIC: Reason?.Invoke("system-sleep", false); break;
                    case PBT_POWERSETTINGCHANGE:
                        // POWERBROADCAST_SETTING: GUID, DWORD DataLength, then the data (0 off, 1 on, 2 dimmed).
                        var setting = Marshal.PtrToStructure<Guid>(m.LParam);
                        if (setting == GUID_CONSOLE_DISPLAY_STATE)
                            Reason?.Invoke("display-off", Marshal.ReadInt32(m.LParam, 20) == 0);
                        break;
                }
                m.Result = 1;
                return;
            default:
                if (m.Msg == (int)TaskbarCreated) ExplorerRestarted?.Invoke();
                break;
        }
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        if (powerHandle != IntPtr.Zero) UnregisterPowerSettingNotification(powerHandle);
        WTSUnRegisterSessionNotification(Handle);
        DestroyHandle();
    }
}

/// <summary>Polled pause inputs: app windows for coverage, full-screen state, screen saver, screen share.</summary>
internal static class Probe
{
    static readonly HashSet<string> ShellClasses = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    /// <summary>Visible app windows of other processes, in physical screen pixels. Cloaked (other virtual
    /// desktops, suspended UWP), minimized, tool and click-through overlay windows do not count.</summary>
    public static List<Box> AppWindows()
    {
        var list = new List<Box>();
        uint me = (uint)Environment.ProcessId;
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            GetWindowThreadProcessId(h, out var pid);
            if (pid == me) return true;
            var ex = GetLong(h, GWL_EXSTYLE);
            if ((ex & WS_EX_TOOLWINDOW) != 0 || (ex & (WS_EX_LAYERED | WS_EX_TRANSPARENT)) == (WS_EX_LAYERED | WS_EX_TRANSPARENT)) return true;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            if (ShellClasses.Contains(ClassName(h))) return true;
            // Extended frame bounds exclude the invisible resize borders that GetWindowRect includes.
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out RECT r, Marshal.SizeOf<RECT>()) != 0 && !GetWindowRect(h, out r)) return true;
            var b = r.ToBox();
            if (!b.IsEmpty) list.Add(b);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>A full-screen app, D3D exclusive full screen or presentation mode is running.</summary>
    public static bool FullScreenApp() =>
        SHQueryUserNotificationState(out var s) == 0 && s is 2 /* BUSY */ or 3 /* D3D_FULL_SCREEN */ or 4 /* PRESENTATION_MODE */;

    public static bool ScreenSaverRunning() => SystemParametersInfo(SPI_GETSCREENSAVERRUNNING, 0, out var on, 0) && on != 0;

    /// <summary>Screen share heuristic: a helper process from config privacy.autoProcesses is running.</summary>
    public static bool AnyProcess(IReadOnlyList<string> names)
    {
        foreach (var n in names)
        {
            var ps = Process.GetProcessesByName(n);
            bool found = ps.Length > 0;
            foreach (var p in ps) p.Dispose();
            if (found) return true;
        }
        return false;
    }
}

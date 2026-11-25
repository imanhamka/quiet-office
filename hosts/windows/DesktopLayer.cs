using QuietOffice.Core;
using static QuietOffice.Native;

namespace QuietOffice;

/// <summary>
/// Puts a window between the desktop picture and the desktop icons. Two shell layouts exist:
/// <list type="bullet">
/// <item>Legacy (Windows 10, Windows 11 before 24H2): message 0x052C makes Progman spawn a top-level
/// WorkerW right behind the top-level window that holds SHELLDLL_DefView. The window becomes a child
/// of that WorkerW.</item>
/// <item>Raised desktop (Windows 11 24H2+): Progman has WS_EX_NOREDIRECTIONBITMAP, and DefView and the
/// wallpaper WorkerW are both children of Progman. The window becomes a WS_EX_LAYERED child of Progman,
/// z-ordered under DefView and above the WorkerW (the layout Lively Wallpaper uses for 24H2).</item>
/// </list>
/// </summary>
internal sealed class DesktopLayer
{
    public IntPtr Progman { get; private init; }
    public IntPtr WorkerW { get; private init; }
    public IntPtr DefView { get; private init; }
    public bool Raised { get; private init; }
    public bool Usable => Progman != IntPtr.Zero && (Raised ? DefView != IntPtr.Zero : WorkerW != IntPtr.Zero);

    public static DesktopLayer Find()
    {
        var progman = FindWindow("Progman", null);
        bool raised = progman != IntPtr.Zero && (GetLong(progman, GWL_EXSTYLE) & WS_EX_NOREDIRECTIONBITMAP) != 0;
        // Undocumented: asks Progman to create the WorkerW behind the icons; a no-op when it exists.
        SendMessageTimeout(progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, out _);

        IntPtr workerW = IntPtr.Zero, defView = IntPtr.Zero;
        if (raised)
        {
            defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            workerW = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
        }
        else
        {
            EnumWindows((top, _) =>
            {
                var dv = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (dv == IntPtr.Zero) return true;
                defView = dv;
                workerW = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);   // the next top-level WorkerW
                return false;
            }, IntPtr.Zero);
        }
        var layer = new DesktopLayer { Progman = progman, WorkerW = workerW, DefView = defView, Raised = raised };
        Log.Info($"desktop layer layout={(raised ? "raised" : "legacy")} progman={progman:X} workerw={workerW:X} defview={defView:X}");
        return layer;
    }

    /// <summary>Re-parents <paramref name="hwnd"/> and sizes it to <paramref name="screen"/> (physical px).</summary>
    public bool Attach(IntPtr hwnd, Box screen)
    {
        if (!Usable) return false;
        // SetParent does not update WS_CHILD/WS_POPUP; the docs say to swap them before the call.
        var style = GetLong(hwnd, GWL_STYLE);
        SetLong(hwnd, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD);
        var parent = Raised ? Progman : WorkerW;
        if (Raised)
        {
            // The layered style must be set before SetParent, and alpha 255 keeps presents cheap.
            SetLong(hwnd, GWL_EXSTYLE, GetLong(hwnd, GWL_EXSTYLE) | WS_EX_LAYERED);
            SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
        }
        if (SetParent(hwnd, parent) == IntPtr.Zero)
        {
            Log.Info($"SetParent failed error={System.Runtime.InteropServices.Marshal.GetLastWin32Error()}");
            return false;
        }
        // Child coordinates are relative to the parent's client area, which spans the virtual screen.
        var r = new RECT { Left = screen.Left, Top = screen.Top, Right = screen.Right, Bottom = screen.Bottom };
        MapWindowPoints(IntPtr.Zero, parent, ref r, 2);
        if (Raised)
        {
            // Insert after DefView = directly below the icons.
            SetWindowPos(hwnd, DefView, r.Left, r.Top, screen.Width, screen.Height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            KeepWorkerWAtBottom();
        }
        else
        {
            SetWindowPos(hwnd, IntPtr.Zero, r.Left, r.Top, screen.Width, screen.Height, SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
        }
        return true;
    }

    /// <summary>Raised layout only: the WorkerW draws the desktop picture and must stay the last child.</summary>
    public void KeepWorkerWAtBottom()
    {
        if (!Raised || WorkerW == IntPtr.Zero) return;
        var last = GetWindow(GetWindow(Progman, GW_CHILD), GW_HWNDLAST);
        if (last != WorkerW) SetWindowPos(WorkerW, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

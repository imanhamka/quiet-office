using System.Drawing;
using System.Drawing.Drawing2D;
using Microsoft.Win32;

namespace QuietOffice;

internal enum IconState { Normal, Off, Attention, Paused }

/// <summary>Tray icons drawn at runtime (a framed picture with a small figure), so no art files ship.</summary>
internal static class TrayArt
{
    static readonly Dictionary<IconState, Icon> Cache = [];

    public static Icon Get(IconState state)
    {
        if (Cache.TryGetValue(state, out var icon)) return icon;
        int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float u = size / 16f;
            var ink = state == IconState.Off ? Color.FromArgb(150, 128, 128, 128) : Color.FromArgb(235, 232, 226);
            using var outline = new Pen(Color.FromArgb(state == IconState.Off ? 90 : 200, 20, 18, 22), u * 1.2f);
            using var fill = new SolidBrush(ink);
            var frame = new RectangleF(1.5f * u, 2.5f * u, 13 * u, 10 * u);
            g.FillRectangle(fill, frame);
            g.DrawRectangle(outline, frame.X, frame.Y, frame.Width, frame.Height);
            using var figure = new SolidBrush(Color.FromArgb(state == IconState.Off ? 110 : 255, 60, 70, 90));
            g.FillEllipse(figure, 6.5f * u, 4.5f * u, 3 * u, 3 * u);
            g.FillRectangle(figure, 5.5f * u, 8f * u, 5 * u, 3.5f * u);
            if (state == IconState.Attention)
            {
                using var dot = new SolidBrush(Color.FromArgb(255, 176, 32));
                g.FillEllipse(dot, 9.5f * u, 8.5f * u, 6.5f * u, 6.5f * u);
                g.DrawEllipse(outline, 9.5f * u, 8.5f * u, 6.5f * u, 6.5f * u);
            }
            else if (state == IconState.Paused)
            {
                using var bar = new SolidBrush(Color.FromArgb(70, 140, 230));
                g.FillRectangle(bar, 10f * u, 9f * u, 2.2f * u, 6.5f * u);
                g.FillRectangle(bar, 13.3f * u, 9f * u, 2.2f * u, 6.5f * u);
            }
        }
        var h = bmp.GetHicon();
        using (var tmp = Icon.FromHandle(h)) icon = (Icon)tmp.Clone();
        Native.DestroyIcon(h);                  // FromHandle does not own the HICON
        Cache[state] = icon;
        return icon;
    }
}

/// <summary>HKCU Run entry, shared with scripts/windows/install.ps1 (same value name).</summary>
internal static class Autostart
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run", Name = "QuietOffice";

    public static bool IsOn()
    {
        using var k = Registry.CurrentUser.OpenSubKey(Key);
        return k?.GetValue(Name) is string;
    }

    public static void Set(bool on, string? repo)
    {
        using var k = Registry.CurrentUser.CreateSubKey(Key);
        if (!on) { k.DeleteValue(Name, false); return; }
        var cmd = $"\"{Environment.ProcessPath}\"" + (repo is null ? "" : $" --repo \"{repo.TrimEnd('\\')}\"");
        k.SetValue(Name, cmd, RegistryValueKind.String);
    }
}

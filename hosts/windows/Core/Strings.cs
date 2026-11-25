namespace QuietOffice.Core;

/// <summary>Tray text in English and Malay. Placeholders use string.Format.</summary>
public sealed record Strings(
    string Culture, string WallpaperOn, string Pause, string Pause15, string Pause60, string PauseMorning,
    string ResumeNow, string PausedUntil, string Agents, string Active, string Idle, string WaitingCount, string Sub,
    string ServerDown, string WaitPermission, string WaitInput, string AndMore, string Today, string TodayUnknown,
    string Privacy, string PrivacyAuto, string PrivacyAutoActive, string DayNight, string DayAuto, string Day,
    string Night, string Notify, string Reload, string Advanced, string RestartServer, string OpenLogs,
    string StartAtLogin, string Quit, string NotifyPermission, string NotifyInput, string TipOff, string TipWaiting,
    string TipPaused)
{
    public static readonly Strings En = new(
        "en-US", "Wallpaper on", "Pause", "15 min", "1 hour", "Until 7:00 tomorrow",
        "Resume now", "Paused until {0}", "AGENTS", "{0} active", "{0} idle", "{0} waiting", "{0} sub",
        "Server not reachable", "waiting for permission", "waiting for input", "and {0} more",
        "Today: {0} sessions · {1} subtasks", "Today: —",
        "Privacy mode", "Auto during screen share", "Active: screen share detected", "Day / Night", "Follow clock", "Day",
        "Night", "Notify when an agent waits > 2 min", "Reload", "Advanced", "Restart server", "Open logs",
        "Start at login", "Quit", "{0} is waiting for permission", "{0} is waiting for input", "Quiet Office: off",
        "Quiet Office: an agent is waiting", "Quiet Office: paused");

    public static readonly Strings Ms = new(
        "ms-MY", "Wallpaper Hidup", "Jeda", "15 minit", "1 jam", "Hingga esok pagi (7:00)",
        "Sambung sekarang", "Dijeda hingga {0}", "EJEN", "{0} aktif", "{0} rehat", "{0} menunggu", "{0} sub",
        "Pelayan tidak dapat dihubungi", "menunggu kebenaran", "menunggu arahan", "dan {0} lagi",
        "Hari ini: {0} sesi · {1} subtugas", "Hari ini: —",
        "Mod Privasi", "Auto semasa kongsi skrin", "Sedang aktif: perkongsian skrin dikesan", "Siang / Malam", "Ikut jam", "Siang",
        "Malam", "Beritahu bila ejen menunggu > 2 min", "Muat Semula", "Lanjutan", "Mulakan Semula Pelayan",
        "Buka Folder Log", "Mula semasa log masuk", "Keluar", "{0} menunggu kebenaran", "{0} menunggu arahan",
        "Quiet Office: dimatikan", "Quiet Office: ejen menunggu", "Quiet Office: dijeda");

    public static Strings For(string lang) => lang == "ms" ? Ms : En;
}

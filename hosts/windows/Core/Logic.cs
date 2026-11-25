// Pure logic shared with QuietOffice.Tests. No Win32 or WinForms here: the tests run on any OS.
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace QuietOffice.Core;

/// <summary>Rectangle in physical pixels, exclusive right/bottom (Win32 RECT semantics).</summary>
public readonly record struct Box(int Left, int Top, int Right, int Bottom)
{
    public int Width => Right - Left;
    public int Height => Bottom - Top;
    public bool IsEmpty => Width <= 0 || Height <= 0;
    public Box Intersect(Box o) => new(Math.Max(Left, o.Left), Math.Max(Top, o.Top), Math.Min(Right, o.Right), Math.Min(Bottom, o.Bottom));
    public bool Intersects(Box o) => !Intersect(o).IsEmpty;
    public static Box FromXywh(int x, int y, int w, int h) => new(x, y, x + w, y + h);
}

public static class Coverage
{
    public const int Cols = 64, Rows = 36;

    /// <summary>Covered fraction of <paramref name="screen"/>, counting overlaps once: a grid cell
    /// counts as covered when its centre lies inside any rectangle (same grid as the macOS host).</summary>
    public static double Fraction(Box screen, IEnumerable<Box> rects)
    {
        if (screen.IsEmpty) return 0;
        var grid = new bool[Cols * Rows];
        double cw = screen.Width / (double)Cols, ch = screen.Height / (double)Rows;
        foreach (var r in rects)
        {
            var i = r.Intersect(screen);
            if (i.IsEmpty) continue;
            int c0 = Math.Max(0, (int)Math.Ceiling((i.Left - screen.Left) / cw - 0.5));
            int c1 = Math.Min(Cols - 1, (int)Math.Ceiling((i.Right - screen.Left) / cw - 0.5) - 1);
            int r0 = Math.Max(0, (int)Math.Ceiling((i.Top - screen.Top) / ch - 0.5));
            int r1 = Math.Min(Rows - 1, (int)Math.Ceiling((i.Bottom - screen.Top) / ch - 0.5) - 1);
            for (int row = r0; row <= r1; row++)
                for (int col = c0; col <= c1; col++) grid[row * Cols + col] = true;
        }
        return grid.Count(c => c) / (double)(Cols * Rows);
    }
}

public static class Insets
{
    /// <summary>Safe area as "top,right,bottom,left" in CSS pixels. Bounds and work area are physical
    /// pixels; the page lays out at the monitor scale, so each edge is divided by it.</summary>
    public static string Compute(Box bounds, Box workArea, double scale)
    {
        if (scale <= 0) scale = 1;
        int Edge(int px) => (int)Math.Round(Math.Max(0, px) / scale);
        return string.Join(",", Edge(workArea.Top - bounds.Top), Edge(bounds.Right - workArea.Right),
            Edge(bounds.Bottom - workArea.Bottom), Edge(workArea.Left - bounds.Left));
    }
}

public enum Daypart { Auto, Day, Night }

public static class Page
{
    public static string Url(int port, int screen, string insets, string lang, bool demo) =>
        $"http://127.0.0.1:{port}/?wallpaper=1&screen={screen}&inset={insets}&lang={(lang == "ms" ? "ms" : "en")}" + (demo ? "&demo=1" : "");

    /// <summary>Only the local server's own origin may load in the page.</summary>
    public static bool IsAllowed(string? uri, int port) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttp &&
        u.Host == "127.0.0.1" && u.Port == port && u.UserInfo.Length == 0;

    /// <summary>The setOptions argument, built from enums and booleans only (never data strings).</summary>
    public static string Options(bool privacy, Daypart daypart, string lang) =>
        $"{{privacy:{(privacy ? "true" : "false")},daypart:'{daypart.ToString().ToLowerInvariant()}',lang:'{(lang == "ms" ? "ms" : "en")}'}}";

    public static string Call(string call) =>
        $"(function(){{var w=window.__wallpaper;if(!w)return false;w.{call};return true}})()";
}

public static class Lang
{
    /// <summary>"en" or "ms": config.json lang wins unless "auto"; otherwise any ms* UI culture means ms.</summary>
    public static string Resolve(string? configLang, string uiCultureName)
    {
        if (configLang is "en" or "ms") return configLang;
        return uiCultureName.StartsWith("ms", StringComparison.OrdinalIgnoreCase) ? "ms" : "en";
    }
}

public static class Schedule
{
    public static DateTime NextMorning(DateTime local) => local.Date.AddDays(1).AddHours(7);
}

public enum AgentMode { Active, Idle, Permission, Input }

public sealed record AgentInfo(string Name, AgentMode Mode, DateTimeOffset? WaitingSince, int Subagents)
{
    public bool IsWaiting => Mode is AgentMode.Permission or AgentMode.Input;
}

public sealed record TodayStats(int Sessions, int Subtasks);

public sealed record ServerState(IReadOnlyList<AgentInfo> Agents, TodayStats? Today)
{
    public IReadOnlyList<AgentInfo> Waiting => Agents.Where(a => a.IsWaiting)
        .OrderBy(a => a.WaitingSince ?? DateTimeOffset.MaxValue).ToList();

    /// <summary>Parses GET /state, keeping only name, mode, waitingSince, the sub-agent count and today.</summary>
    public static ServerState? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object ||
                !doc.RootElement.TryGetProperty("agents", out var list) || list.ValueKind != JsonValueKind.Array) return null;
            var agents = new List<AgentInfo>();
            foreach (var a in list.EnumerateArray())
            {
                if (a.ValueKind != JsonValueKind.Object ||
                    !a.TryGetProperty("name", out var n) || n.ValueKind != JsonValueKind.String ||
                    !a.TryGetProperty("mode", out var m) || m.ValueKind != JsonValueKind.String ||
                    !Enum.TryParse<AgentMode>(m.GetString(), true, out var mode) || !Enum.IsDefined(mode) ||
                    int.TryParse(m.GetString(), out _)) continue;
                DateTimeOffset? since = a.TryGetProperty("waitingSince", out var w) && w.ValueKind == JsonValueKind.Number &&
                    w.TryGetInt64(out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : null;
                int subs = a.TryGetProperty("subagents", out var s) && s.ValueKind == JsonValueKind.Array ? s.GetArrayLength() : 0;
                agents.Add(new AgentInfo(CleanName(n.GetString()!), mode, since, subs));
            }
            TodayStats? today = null;
            if (doc.RootElement.TryGetProperty("today", out var t) && t.ValueKind == JsonValueKind.Object &&
                t.TryGetProperty("sessions", out var se) && se.TryGetInt32(out var sessions) &&
                t.TryGetProperty("subtasks", out var st) && st.TryGetInt32(out var subtasks))
                today = new TodayStats(Math.Max(0, sessions), Math.Max(0, subtasks));
            return new ServerState(agents, today);
        }
        catch (JsonException) { return null; }
    }

    // Menu text only: no control characters, at most 40 characters.
    static string CleanName(string raw)
    {
        var sb = new StringBuilder();
        foreach (var ch in raw) if (!char.IsControl(ch)) sb.Append(ch);
        var s = sb.ToString().Trim();
        return s.Length > 40 ? s[..40] : s;
    }
}

public static class MenuText
{
    public const int MaxWaitRows = 5;

    public static string Summary(ServerState? state, Strings t)
    {
        if (state is null) return t.ServerDown;
        var parts = new List<string> { string.Format(t.Active, state.Agents.Count(a => a.Mode == AgentMode.Active)),
            string.Format(t.Idle, state.Agents.Count(a => a.Mode == AgentMode.Idle)) };
        int waiting = state.Waiting.Count;
        if (waiting > 0) parts.Add(string.Format(t.WaitingCount, waiting));
        parts.Add(string.Format(t.Sub, state.Agents.Sum(a => a.Subagents)));
        return string.Join(" · ", parts);
    }

    /// <summary>Up to five rows, oldest wait first, then "and N more".</summary>
    public static List<string> WaitRows(ServerState? state, DateTimeOffset now, Strings t)
    {
        var rows = new List<string>();
        if (state is null) return rows;
        var list = state.Waiting;
        foreach (var a in list.Take(MaxWaitRows))
        {
            var what = a.Mode == AgentMode.Permission ? t.WaitPermission : t.WaitInput;
            var mins = a.WaitingSince is { } s ? $" · {Math.Max(0, (int)(now - s).TotalMinutes)} min" : "";
            rows.Add($"⚠ {a.Name} — {what}{mins}");
        }
        if (list.Count > MaxWaitRows) rows.Add(string.Format(t.AndMore, list.Count - MaxWaitRows));
        return rows;
    }

    public static string Today(TodayStats? today, Strings t) =>
        today is null ? t.TodayUnknown : string.Format(t.Today, today.Sessions, today.Subtasks);

    public static string PausedUntil(DateTime until, DateTime now, Strings t)
    {
        var culture = CultureInfo.GetCultureInfo(t.Culture);
        var fmt = until.Date == now.Date ? "HH:mm" : "ddd HH:mm";
        return string.Format(t.PausedUntil, until.ToString(fmt, culture));
    }
}

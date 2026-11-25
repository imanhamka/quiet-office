using System.Text.Json;
using System.Text.Json.Serialization;

namespace QuietOffice.Core;

/// <summary>Host state saved in %APPDATA%\quiet-office\host-state.json. The host owns this file.</summary>
public sealed class HostSettings
{
    public bool Enabled { get; set; } = true;
    /// <summary>End of a timed pause, Unix seconds.</summary>
    public long? PausedUntil { get; set; }
    /// <summary>Null until the user toggles it; config.json privacy.default applies until then.</summary>
    public bool? Privacy { get; set; }
    public bool PrivacyAuto { get; set; } = true;
    public Daypart Daypart { get; set; } = Daypart.Auto;
    public bool NotifyWaiting { get; set; }
    /// <summary>Optional path to server/server.mjs; found next to the app when empty.</summary>
    public string? ServerScript { get; set; }
    /// <summary>Optional node executable; "node" from PATH when empty.</summary>
    public string? NodePath { get; set; }

    static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    /// <summary>Missing or unreadable file = defaults.</summary>
    public static HostSettings Load(string path)
    {
        try { return JsonSerializer.Deserialize<HostSettings>(File.ReadAllText(path), Json) ?? new(); }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }

    /// <summary>Writes a temp file in the same directory, flushes it, then renames it over the old one,
    /// so a crash leaves either the old or the new file, never half of one.</summary>
    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var tmp = path + ".tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(fs, this, Json);
            fs.Flush(true);
        }
        File.Move(tmp, path, overwrite: true);
    }
}

/// <summary>Read-only view of config.json (shared with the server). Missing or invalid = defaults.</summary>
public sealed record AppConfig(string? Lang, bool PrivacyDefault, IReadOnlyList<string> AutoProcesses)
{
    public static readonly AppConfig Default = new(null, false, ["CptHost"]);

    public static AppConfig Load(string path)
    {
        try { return Parse(File.ReadAllText(path)); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return Default; }
    }

    public static AppConfig Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions
            { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Default;
            string? lang = root.TryGetProperty("lang", out var l) && l.GetString() is "en" or "ms" ? l.GetString() : null;
            bool privacy = false;
            var procs = Default.AutoProcesses;
            if (root.TryGetProperty("privacy", out var p) && p.ValueKind == JsonValueKind.Object)
            {
                privacy = p.TryGetProperty("default", out var d) && d.ValueKind == JsonValueKind.True;
                if (p.TryGetProperty("autoProcesses", out var a) && a.ValueKind == JsonValueKind.Array)
                    procs = a.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
                        .Select(x => Path.GetFileNameWithoutExtension(x.GetString()!))
                        .Where(x => x.Length > 0).ToList();
            }
            return new AppConfig(lang, privacy, procs);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException) { return Default; }
    }
}

public static class Locate
{
    /// <summary>The configured script if it exists, else the first server/server.mjs found walking up
    /// from <paramref name="startDir"/> (the publish output sits inside the repo).</summary>
    public static string? ServerScript(string? configured, string startDir, int maxLevels = 8)
    {
        if (!string.IsNullOrWhiteSpace(configured)) return File.Exists(configured) ? Path.GetFullPath(configured) : null;
        var dir = new DirectoryInfo(startDir);
        for (int i = 0; dir is not null && i <= maxLevels; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "server", "server.mjs");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}

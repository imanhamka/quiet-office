// Quiet Office host for Windows (experimental). One borderless WebView2 window per monitor, placed
// behind the desktop icons. It shows http://127.0.0.1:<port>/?wallpaper=1&screen=<n>&inset=..&lang=..
// and tells the page to pause or resume. It supervises `node server/server.mjs` as a child process.
//
// Args: [port] [--port N] [--repo DIR] [--demo]. Env: QUIET_OFFICE_PORT (default 47100),
// QUIET_OFFICE_DEBUG=1 (coverage log every check; devtools in Debug builds only), QUIET_OFFICE_COVER_THRESHOLD (testing only).
using System.Text;

namespace QuietOffice;

internal static class Paths
{
    public static readonly string Roaming = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "quiet-office");
    public static readonly string Local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "quiet-office");
    public static readonly string Logs = Path.Combine(Local, "logs");
    public static readonly string WebView = Path.Combine(Local, "webview2");
    public static readonly string State = Path.Combine(Roaming, "host-state.json");
    public static readonly string Config = Path.Combine(Roaming, "config.json");
}

internal static class Log
{
    static readonly object Gate = new();
    static StreamWriter? writer;

    public static StreamWriter Open(string name)
    {
        Directory.CreateDirectory(Paths.Logs);
        var path = Path.Combine(Paths.Logs, name);
        // One rotation step at start keeps each log under ~5 MB plus one old copy.
        if (File.Exists(path) && new FileInfo(path).Length > 5_000_000) File.Move(path, path + ".1", overwrite: true);
        return new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)) { AutoFlush = true };
    }

    public static void Info(string line)
    {
        lock (Gate)
        {
            try { (writer ??= Open("host.log")).WriteLine($"{DateTimeOffset.Now:yyyy-MM-ddTHH:mm:sszzz} {line}"); }
            catch (IOException) { }
        }
    }
}

internal sealed record Options(int Port, string? Repo, bool Demo, bool Debug, double CoverThreshold)
{
    public static Options Parse(string[] args)
    {
        static int? ParsePort(string? s) => int.TryParse(s, out var p) && p is >= 1 and <= 65535 ? p : null;
        int? port = null;
        string? repo = null;
        bool demo = false;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--port" when i + 1 < args.Length: port = ParsePort(args[++i]); break;
                case "--repo" when i + 1 < args.Length: repo = args[++i]; break;
                case "--demo": demo = true; break;
                default: port ??= ParsePort(args[i]); break;
            }
        }
        var env = Environment.GetEnvironmentVariables();
        port ??= ParsePort(env["QUIET_OFFICE_PORT"] as string) ?? 47100;
        bool debug = env["QUIET_OFFICE_DEBUG"] as string == "1";
        double threshold = double.TryParse(env["QUIET_OFFICE_COVER_THRESHOLD"] as string, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var t) ? t : 0.90;
        return new Options(port.Value, repo, demo, debug, threshold);
    }
}

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // One copy per user session: autostart and a manual run can both start it.
        using var single = new Mutex(true, @"Local\QuietOffice.Host", out bool first);
        if (!first) return;
        var opts = Options.Parse(args);
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Log.Info($"start port={opts.Port} screens={Screen.AllScreens.Length} threshold={opts.CoverThreshold} debug={opts.Debug} os={Environment.OSVersion.Version}");
        Application.Run(new HostApp(opts));
    }
}

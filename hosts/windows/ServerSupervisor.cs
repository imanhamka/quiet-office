using System.Diagnostics;

namespace QuietOffice;

/// <summary>Runs `node server/server.mjs` as a child in a kill-on-close job object, so the server dies
/// with the host even when the host crashes. Restarts it with backoff; leaves a server it did not
/// start alone (another copy already answering /healthz).</summary>
internal sealed class ServerSupervisor : IDisposable
{
    readonly string? script;
    readonly string node;
    readonly int port;
    readonly HttpClient http;
    readonly IntPtr job = Native.CreateKillOnCloseJob();
    readonly System.Windows.Forms.Timer timer = new();
    readonly SynchronizationContext ui;
    StreamWriter? log;
    Process? child;
    int backoffMs = 2000;
    bool disposed;

    /// <summary>The absolute path of an executable found on PATH, so the server runs the node seen at
    /// startup rather than whatever a later PATH or working-directory lookup would pick.</summary>
    static string? ResolveOnPath(string exe)
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir) || !Path.IsPathRooted(dir.Trim())) continue;
            var candidate = Path.Combine(dir.Trim(), exe);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    public ServerSupervisor(string? script, string? node, int port, HttpClient http)
    {
        this.script = script;
        this.node = string.IsNullOrWhiteSpace(node) ? ResolveOnPath("node.exe") ?? "node" : node;
        this.port = port;
        this.http = http;
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        timer.Tick += async (_, _) => { timer.Stop(); await EnsureRunningAsync(); };
    }

    public void Start()
    {
        if (script is null) { Log.Info("server/server.mjs not found; set serverScript in host-state.json or pass --repo"); return; }
        Schedule(10);
    }

    void Schedule(int ms) { timer.Interval = Math.Max(10, ms); timer.Start(); }

    async Task<bool> HealthyAsync()
    {
        try { return (await http.GetStringAsync($"http://127.0.0.1:{port}/healthz")).Trim() == "ok"; }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return false; }
    }

    async Task EnsureRunningAsync()
    {
        if (disposed || child is not null || script is null) return;
        if (await HealthyAsync()) { Schedule(30_000); return; }   // someone else serves the port
        var psi = new ProcessStartInfo(node)
        {
            WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(script))!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(script);
        psi.Environment["QUIET_OFFICE_PORT"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        try
        {
            log ??= Log.Open("server.log");
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            p.OutputDataReceived += (_, e) => Write(e.Data);
            p.ErrorDataReceived += (_, e) => Write(e.Data);
            p.Exited += (_, _) => ui.Post(_ => OnExited(p), null);
            p.Start();
            if (job != IntPtr.Zero && !Native.AssignProcessToJobObject(job, p.Handle)) Log.Info("server: job object assign failed");
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            child = p;
            Log.Info($"server started pid={p.Id} node={node}");
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Log.Info($"server start failed ({e.Message}); is Node.js >= 22 on PATH?");
            Backoff();
        }
    }

    void Write(string? line)
    {
        if (line is null || log is null) return;
        lock (log) log.WriteLine(line);
    }

    void OnExited(Process p)
    {
        if (p != child) return;
        int code = p.ExitCode;
        p.Dispose();
        child = null;
        if (disposed) return;
        Log.Info($"server exited code={code}");
        Backoff();
    }

    void Backoff()
    {
        Schedule(backoffMs);
        backoffMs = Math.Min(backoffMs * 2, 60_000);
    }

    /// <summary>Menu action: stop the child (if this host owns it) and start a fresh one.</summary>
    public void Restart()
    {
        backoffMs = 2000;
        var p = child;
        child = null;
        if (p is not null)
        {
            Log.Info($"server restart pid={p.Id}");
            try { p.Kill(entireProcessTree: true); p.WaitForExit(3000); }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            p.Dispose();
        }
        else Log.Info("server restart: no child owned by this host");
        Schedule(500);
    }

    public void Dispose()
    {
        disposed = true;
        timer.Dispose();
        try { child?.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        child?.Dispose();
        // Closing the job handle also kills anything the server left behind.
        if (job != IntPtr.Zero) CloseHandle(job);
        log?.Dispose();
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
}

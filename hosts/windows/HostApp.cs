using System.Diagnostics;
using System.Globalization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using QuietOffice.Core;

namespace QuietOffice;

/// <summary>Tray, pause logic and window lifetime. Read-only toward Claude sessions: the tray shows
/// agent names and states from GET /state and sends nothing anywhere.</summary>
internal sealed class HostApp : ApplicationContext
{
    // Behind the desktop icons Chromium sees the window as occluded and would throttle or freeze it.
    const string BrowserArgs = "--disable-features=CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding";

    readonly Options opts;
    readonly HostSettings settings = HostSettings.Load(Paths.State);
    readonly AppConfig config = AppConfig.Load(Paths.Config);
    readonly string lang;
    readonly Strings t;
    readonly HttpClient http = new(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
    readonly ContextMenuStrip menu = new() { ShowImageMargin = false, ShowCheckMargin = true };
    readonly NotifyIcon tray = new();
    readonly SynchronizationContext ui;
    readonly SignalWindow signals = new();
    readonly ServerSupervisor server;
    readonly string? repo;
    readonly System.Windows.Forms.Timer checkTimer = new() { Interval = 2000 };
    readonly System.Windows.Forms.Timer stateTimer = new() { Interval = 10_000 };
    readonly System.Windows.Forms.Timer rebuildTimer = new() { Interval = 1000 };
    readonly HashSet<string> reasons = [];
    readonly HashSet<string> notified = [];
    List<WallpaperForm> walls = [];
    CoreWebView2Environment? env;
    DesktopLayer? layer;
    ServerState? state;
    bool running, building, rebuildAgain, sharing, fetching;

    ToolStripMenuItem toggleItem = null!, pauseItem = null!, resumeItem = null!, privacyItem = null!, privacyAutoItem = null!,
        notifyItem = null!, reloadItem = null!, loginItem = null!;
    readonly List<ToolStripMenuItem> dayItems = [];
    readonly List<ToolStripLabel> waitRows = [];
    ToolStripLabel summaryRow = null!, todayRow = null!;

    public HostApp(Options opts)
    {
        this.opts = opts;
        lang = Lang.Resolve(config.Lang, CultureInfo.CurrentUICulture.Name);
        t = Strings.For(lang);
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        var script = Locate.ServerScript(settings.ServerScript, opts.Repo ?? AppContext.BaseDirectory);
        repo = script is null ? opts.Repo : Path.GetDirectoryName(Path.GetDirectoryName(script));
        server = new ServerSupervisor(script, settings.NodePath, opts.Port, http);
        server.Start();

        signals.Reason += (reason, on) => { if (on) reasons.Add(reason); else reasons.Remove(reason); Check(); };
        signals.ExplorerRestarted += () => { Log.Info("explorer restarted; rebuilding windows"); ScheduleRebuild(); };
        SystemEvents.DisplaySettingsChanged += OnDisplayChanged;
        rebuildTimer.Tick += async (_, _) => { rebuildTimer.Stop(); if (running) await BuildWallsAsync(); };
        checkTimer.Tick += (_, _) => Check();
        stateTimer.Tick += async (_, _) => await FetchStateAsync();

        BuildMenu();
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        UpdateIcon();
        if (settings.Enabled) Start(); else Log.Info("disabled (saved); no windows");
        stateTimer.Start();
        _ = FetchStateAsync();
    }

    bool PrivacyOn => (settings.Privacy ?? config.PrivacyDefault) || sharing;
    string PageOptions => Page.Options(PrivacyOn, settings.Daypart, lang);
    DateTime? PausedUntil => settings.PausedUntil is long s ? DateTimeOffset.FromUnixTimeSeconds(s).LocalDateTime : null;

    void Save()
    {
        try { settings.Save(Paths.State); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { Log.Info($"save failed: {e.Message}"); }
    }

    // SystemEvents can fire on its own thread.
    void OnDisplayChanged(object? sender, EventArgs e) => ui.Post(_ => { Log.Info("displays changed"); ScheduleRebuild(); }, null);

    void ScheduleRebuild() { rebuildTimer.Stop(); rebuildTimer.Start(); }

    // MARK: windows

    async void Start()
    {
        if (running) return;
        Log.Info("wallpaper on");
        running = true;
        checkTimer.Start();
        await BuildWallsAsync();
    }

    void Stop()
    {
        if (!running) return;
        Log.Info($"wallpaper off: closing {walls.Count} window(s)");
        running = false;
        checkTimer.Stop();
        CloseWalls();
    }

    void CloseWalls()
    {
        foreach (var w in walls) w.Shutdown();
        walls = [];
    }

    async Task BuildWallsAsync()
    {
        if (building) { rebuildAgain = true; return; }
        building = true;
        try
        {
            do
            {
                rebuildAgain = false;
                CloseWalls();
                try
                {
                    env ??= await CoreWebView2Environment.CreateAsync(null, Paths.WebView, new CoreWebView2EnvironmentOptions(BrowserArgs));
                }
                catch (WebView2RuntimeNotFoundException)
                {
                    Log.Info("WebView2 Runtime not installed; get it from Microsoft (Evergreen Runtime)");
                    return;
                }
                if (!running) return;
                layer = DesktopLayer.Find();
                if (!layer.Usable)
                {
                    Log.Info("desktop layer not found; retrying in 10s");
                    rebuildTimer.Interval = 10_000;
                    ScheduleRebuild();
                    return;
                }
                rebuildTimer.Interval = 1000;
                var screens = Screen.AllScreens;
                Log.Info($"building {screens.Length} window(s)");
                for (int i = 0; i < screens.Length && running && !rebuildAgain; i++)
                {
                    var w = new WallpaperForm(screens[i], i, opts.Port, lang, opts.Demo, opts.Debug);
                    walls.Add(w);
                    if (!await w.StartAsync(layer, env)) Log.Info($"screen={i} attach to desktop failed");
                }
            } while (rebuildAgain && running);
            if (!running) CloseWalls();
        }
        finally { building = false; }
        Check();
    }

    void Check()
    {
        if (PausedUntil is { } until && until > DateTime.Now) reasons.Add("timed");
        else
        {
            if (settings.PausedUntil is not null) { settings.PausedUntil = null; Save(); Log.Info("timed pause over"); UpdateIcon(); }
            reasons.Remove("timed");
        }
        bool share = settings.PrivacyAuto && Probe.AnyProcess(config.AutoProcesses);
        if (share != sharing)
        {
            sharing = share;
            Log.Info(share ? "screen share detected: privacy on" : "screen share over");
        }
        if (!running || walls.Count == 0) return;
        var why = new SortedSet<string>(reasons);
        if (Probe.FullScreenApp()) why.Add("fullscreen");
        if (Probe.ScreenSaverRunning()) why.Add("screensaver");
        var windows = Probe.AppWindows();
        foreach (var wall in walls)
        {
            var onScreen = windows.Where(b => b.Intersects(wall.ScreenBox)).ToList();
            double covered = Coverage.Fraction(wall.ScreenBox, onScreen);
            var mine = new SortedSet<string>(why);
            if (covered >= opts.CoverThreshold) mine.Add("covered");
            var pct = (covered * 100).ToString("0.0", CultureInfo.InvariantCulture) + "%";
            if (opts.Debug) Log.Info($"debug screen={wall.Index} coverage={pct} windows={onScreen.Count} reasons={string.Join(",", mine)}");
            wall.UpdateInsets();
            wall.UpdateOptions(PageOptions);
            wall.Apply(mine.Count > 0, (mine.Count > 0 ? string.Join(",", mine) : "visible") + $" coverage={pct}");
        }
        layer?.KeepWorkerWAtBottom();
    }

    // MARK: agent data (GET /state, whitelisted fields)

    async Task FetchStateAsync()
    {
        if (fetching) return;
        fetching = true;
        try
        {
            using var res = await http.GetAsync($"http://127.0.0.1:{opts.Port}/state");
            state = res.IsSuccessStatusCode ? ServerState.Parse(await res.Content.ReadAsStringAsync()) : null;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { state = null; }
        finally { fetching = false; }
        NotifyLongWaits();
        UpdateIcon();
        if (menu.Visible) RefreshMenu();
    }

    /// <summary>One balloon per wait longer than 2 min. Off by default, never in privacy mode.</summary>
    void NotifyLongWaits()
    {
        var waiting = state?.Waiting ?? [];
        var keys = waiting.Where(a => a.WaitingSince is not null).Select(a => $"{a.Name}|{a.WaitingSince!.Value.ToUnixTimeMilliseconds()}").ToHashSet();
        notified.IntersectWith(keys);
        if (!settings.NotifyWaiting || PrivacyOn) return;
        foreach (var a in waiting)
        {
            if (a.WaitingSince is not { } since || DateTimeOffset.Now - since < TimeSpan.FromMinutes(2)) continue;
            if (!notified.Add($"{a.Name}|{since.ToUnixTimeMilliseconds()}")) continue;
            tray.ShowBalloonTip(5000, "Quiet Office", string.Format(a.Mode == AgentMode.Permission ? t.NotifyPermission : t.NotifyInput, a.Name), ToolTipIcon.None);
            Log.Info("notified wait");
        }
    }

    void UpdateIcon()
    {
        var (icon, tip) = !settings.Enabled ? (IconState.Off, t.TipOff)
            : state?.Waiting.Count > 0 ? (IconState.Attention, t.TipWaiting)
            : PausedUntil > DateTime.Now ? (IconState.Paused, t.TipPaused)
            : (IconState.Normal, "Quiet Office");
        tray.Icon = TrayArt.Get(icon);
        tray.Text = tip;
    }

    // MARK: menu

    ToolStripMenuItem Item(string text, Action onClick)
    {
        var it = new ToolStripMenuItem(text);
        it.Click += (_, _) => onClick();
        return it;
    }

    static ToolStripLabel Row() => new() { Padding = new Padding(8, 1, 0, 1) };

    void BuildMenu()
    {
        toggleItem = Item(t.WallpaperOn, ToggleEnabled);
        pauseItem = new ToolStripMenuItem(t.Pause);
        pauseItem.DropDownItems.Add(Item(t.Pause15, () => PauseFor(DateTime.Now.AddMinutes(15))));
        pauseItem.DropDownItems.Add(Item(t.Pause60, () => PauseFor(DateTime.Now.AddHours(1))));
        pauseItem.DropDownItems.Add(Item(t.PauseMorning, () => PauseFor(Schedule.NextMorning(DateTime.Now))));
        pauseItem.DropDownItems.Add(new ToolStripSeparator());
        pauseItem.DropDownItems.Add(resumeItem = Item(t.ResumeNow, ResumeNow));

        menu.Items.AddRange([toggleItem, pauseItem, new ToolStripSeparator(), new ToolStripMenuItem(t.Agents) { Enabled = false }]);
        menu.Items.Add(summaryRow = Row());
        for (int i = 0; i <= MenuText.MaxWaitRows; i++) { var r = Row(); waitRows.Add(r); menu.Items.Add(r); }
        menu.Items.Add(todayRow = Row());

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(privacyItem = Item(t.Privacy, () =>
        {
            settings.Privacy = !(settings.Privacy ?? config.PrivacyDefault);
            Save();
            Log.Info($"privacy {(settings.Privacy == true ? "on" : "off")} from menu");
            SyncOptions();
        }));
        menu.Items.Add(privacyAutoItem = Item(t.PrivacyAuto, () =>
        {
            settings.PrivacyAuto = !settings.PrivacyAuto;
            if (!settings.PrivacyAuto) sharing = false;
            Save();
            SyncOptions();
        }));
        privacyAutoItem.Padding = new Padding(16, 0, 0, 0);
        var dayItem = new ToolStripMenuItem(t.DayNight);
        foreach (var (text, d) in new[] { (t.DayAuto, Daypart.Auto), (t.Day, Daypart.Day), (t.Night, Daypart.Night) })
        {
            var it = Item(text, () => { settings.Daypart = d; Save(); Log.Info($"daypart {d}"); SyncOptions(); });
            it.Tag = d;
            dayItems.Add(it);
            dayItem.DropDownItems.Add(it);
        }
        menu.Items.Add(dayItem);
        menu.Items.Add(notifyItem = Item(t.Notify, () => { settings.NotifyWaiting = !settings.NotifyWaiting; Save(); }));

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(reloadItem = Item(t.Reload, () => { Log.Info("reload all"); foreach (var w in walls) w.Reload(); }));
        var advanced = new ToolStripMenuItem(t.Advanced);
        advanced.DropDownItems.Add(Item(t.RestartServer, () => { server.Restart(); }));
        advanced.DropDownItems.Add(Item(t.OpenLogs, OpenLogs));
        advanced.DropDownItems.Add(loginItem = Item(t.StartAtLogin, () => { Autostart.Set(!Autostart.IsOn(), repo); RefreshMenu(); }));
        menu.Items.Add(advanced);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item(t.Quit, ExitThread));

        menu.Opening += (_, _) => { RefreshMenu(); _ = FetchStateAsync(); };
    }

    void RefreshMenu()
    {
        toggleItem.Checked = settings.Enabled;
        var until = PausedUntil;
        pauseItem.Text = until > DateTime.Now ? MenuText.PausedUntil(until.Value, DateTime.Now, t) : t.Pause;
        pauseItem.Enabled = reloadItem.Enabled = settings.Enabled;
        resumeItem.Enabled = until is not null;
        privacyItem.Checked = settings.Privacy ?? config.PrivacyDefault;
        privacyAutoItem.Checked = settings.PrivacyAuto;
        privacyAutoItem.ToolTipText = sharing ? t.PrivacyAutoActive : null;
        foreach (var it in dayItems) it.Checked = (Daypart)it.Tag! == settings.Daypart;
        notifyItem.Checked = settings.NotifyWaiting;
        loginItem.Checked = Autostart.IsOn();
        summaryRow.Text = MenuText.Summary(state, t);
        todayRow.Text = MenuText.Today(state?.Today, t);
        var rows = MenuText.WaitRows(state, DateTimeOffset.Now, t);
        for (int i = 0; i < waitRows.Count; i++)
        {
            waitRows[i].Visible = i < rows.Count;
            waitRows[i].Text = i < rows.Count ? rows[i].Replace("&", "&&") : "";
        }
    }

    void SyncOptions() { foreach (var w in walls) w.UpdateOptions(PageOptions); }

    void ToggleEnabled()
    {
        settings.Enabled = !settings.Enabled;
        Save();
        Log.Info(settings.Enabled ? "enabled from menu" : "disabled from menu");
        if (settings.Enabled) Start(); else Stop();
        UpdateIcon();
    }

    void PauseFor(DateTime until)
    {
        settings.PausedUntil = new DateTimeOffset(until).ToUnixTimeSeconds();
        Save();
        Log.Info($"timed pause until {until:yyyy-MM-ddTHH:mm}");
        Check();
        UpdateIcon();
    }

    void ResumeNow()
    {
        settings.PausedUntil = null;
        reasons.Remove("timed");
        Save();
        Log.Info("resumed from menu");
        Check();
        UpdateIcon();
    }

    static void OpenLogs()
    {
        Directory.CreateDirectory(Paths.Logs);
        var psi = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
        psi.ArgumentList.Add(Paths.Logs);
        Process.Start(psi)?.Dispose();
    }

    protected override void ExitThreadCore()
    {
        Log.Info("quit");
        SystemEvents.DisplaySettingsChanged -= OnDisplayChanged;
        checkTimer.Dispose();
        stateTimer.Dispose();
        rebuildTimer.Dispose();
        running = false;
        CloseWalls();
        tray.Visible = false;
        tray.Dispose();
        server.Dispose();
        signals.Dispose();
        http.Dispose();
        base.ExitThreadCore();
    }
}

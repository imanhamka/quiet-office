using Microsoft.Web.WebView2.Core;
using QuietOffice.Core;
using static QuietOffice.Native;

namespace QuietOffice;

/// <summary>One monitor's wallpaper: a borderless form re-parented under the desktop icons, hosting a
/// CoreWebView2Controller directly (the controller lets the host fix the rasterization scale, which a
/// child of the desktop cannot learn from WM_DPICHANGED).</summary>
internal sealed class WallpaperForm : Form
{
    static readonly System.Drawing.Color Background = System.Drawing.Color.FromArgb(0x14, 0x12, 0x16);

    public int Index { get; }
    public string DeviceName { get; }
    public Box ScreenBox { get; private set; }
    readonly int port;
    readonly bool debug;
    readonly string url;
    CoreWebView2Controller? controller;
    readonly System.Windows.Forms.Timer retry = new() { Interval = 5000 };
    bool loaded, failing, sending, closed, wantPaused;
    bool? sentPaused;
    string wantReason = "";
    string? sentInsets, sentOptions;

    public WallpaperForm(Screen screen, int index, int port, string lang, bool demo, bool debug)
    {
        Index = index;
        DeviceName = screen.DeviceName;
        this.port = port;
        this.debug = debug;
        ScreenBox = ToBox(screen.Bounds);
        url = Page.Url(port, index, CurrentInsets(screen), lang, demo);
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Background;
        Bounds = screen.Bounds;
        Text = "Quiet Office";
        retry.Tick += (_, _) => { retry.Stop(); Reload(); };
    }

    static Box ToBox(System.Drawing.Rectangle r) => Box.FromXywh(r.X, r.Y, r.Width, r.Height);
    static string CurrentInsets(Screen s) => Insets.Compute(ToBox(s.Bounds), ToBox(s.WorkingArea), ScaleAt(ToBox(s.Bounds)));

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= (int)(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT);
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        // Click-through: never take focus, and let hit tests fall to whatever is underneath.
        if (m.Msg == WM_MOUSEACTIVATE) { m.Result = MA_NOACTIVATE; return; }
        if (m.Msg == WM_NCHITTEST) { m.Result = HTTRANSPARENT; return; }
        base.WndProc(ref m);
    }

    /// <summary>Shows the form, attaches it to the desktop layer, then creates the web view.</summary>
    public async Task<bool> StartAsync(DesktopLayer layer, CoreWebView2Environment env)
    {
        Show();
        if (!layer.Attach(Handle, ScreenBox)) return false;
        controller = await env.CreateCoreWebView2ControllerAsync(Handle);
        if (closed) { controller.Close(); return true; }
        controller.DefaultBackgroundColor = Background;
        controller.ShouldDetectMonitorScaleChanges = false;
        controller.RasterizationScale = ScaleAt(ScreenBox);
        controller.Bounds = new System.Drawing.Rectangle(0, 0, ScreenBox.Width, ScreenBox.Height);
        var core = controller.CoreWebView2;
        var s = core.Settings;
#if DEBUG
        s.AreDevToolsEnabled = debug;
#else
        s.AreDevToolsEnabled = false;
#endif
        s.AreDefaultContextMenusEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsWebMessageEnabled = false;
        s.AreHostObjectsAllowed = false;
        core.NavigationStarting += (_, e) => { if (!Page.IsAllowed(e.Uri, port)) { e.Cancel = true; Log.Info($"screen={Index} blocked navigation"); } };
        core.FrameNavigationStarting += (_, e) => { if (!Page.IsAllowed(e.Uri, port)) e.Cancel = true; };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.NavigationCompleted += OnNavigationCompleted;
        core.ProcessFailed += (_, e) =>
        {
            Log.Info($"screen={Index} web process failed kind={e.ProcessFailedKind}; reloading");
            loaded = false;
            retry.Interval = 1000;
            retry.Start();
        };
        Reload();
        return true;
    }

    public async void Reload()
    {
        if (closed || controller is null) return;
        retry.Stop();
        loaded = false;
        sentPaused = null;
        // Drop cached sub-resources (layout JSON, sprites) so a rebuild shows on reload.
        await controller.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
        if (!closed) controller?.CoreWebView2.Navigate(url);
    }

    void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess || e.HttpStatusCode >= 400)
        {
            loaded = false;
            if (!failing) Log.Info($"screen={Index} load failed ({(e.IsSuccess ? $"HTTP {e.HttpStatusCode}" : e.WebErrorStatus.ToString())}); retrying every 5s");
            failing = true;
            retry.Interval = 5000;
            retry.Start();
            return;
        }
        Log.Info($"screen={Index} loaded {url}");
        failing = false;
        loaded = true;
        sentPaused = null;
        sentInsets = null;
        sentOptions = null;
        Apply(wantPaused, wantReason);
    }

    async Task<bool> RunAsync(string js)
    {
        if (controller is null || closed) return false;
        try { return await controller.CoreWebView2.ExecuteScriptAsync(js) == "true"; }
        catch (Exception e) when (e is InvalidOperationException or System.Runtime.InteropServices.COMException) { return false; }
    }

    /// <summary>Tells the page the wanted state when it differs from what it was last told. If
    /// window.__wallpaper is not defined yet, the next check tries again.</summary>
    public async void Apply(bool paused, string reason)
    {
        wantPaused = paused;
        wantReason = reason;
        if (!loaded || sending || sentPaused == paused) return;
        sending = true;
        bool ok = await RunAsync(Page.Call(paused ? "pause()" : "resume(12)"));
        sending = false;
        if (ok)
        {
            sentPaused = paused;
            Log.Info($"screen={Index} {(paused ? "pause" : "resume")} reason={reason}");
        }
        if (sentPaused is not null && sentPaused != wantPaused) Apply(wantPaused, wantReason);
    }

    /// <summary>Taskbar moves or auto-hide changes reach the page without a reload.</summary>
    public async void UpdateInsets()
    {
        var screen = Screen.AllScreens.FirstOrDefault(s => s.DeviceName == DeviceName);
        if (!loaded || screen is null) return;
        var now = CurrentInsets(screen);
        if (now == sentInsets) return;
        if (await RunAsync($"(function(){{var w=window.__wallpaper;if(!w||!w.setInsets)return false;w.setInsets({now});return true}})()"))
        {
            if (sentInsets is not null) Log.Info($"screen={Index} insets={now}");
            sentInsets = now;
        }
    }

    public async void UpdateOptions(string options)
    {
        if (!loaded || options == sentOptions) return;
        if (await RunAsync($"(function(){{var w=window.__wallpaper;if(!w||!w.setOptions)return false;w.setOptions({options});return true}})()"))
        {
            Log.Info($"screen={Index} options={options}");
            sentOptions = options;
        }
    }

    public void Shutdown()
    {
        closed = true;
        retry.Stop();
        retry.Dispose();
        controller?.Close();
        controller = null;
        // An Explorer restart destroys the parent, and with it this window, before the rebuild runs.
        if (!IsDisposed) { Close(); Dispose(); }
    }
}

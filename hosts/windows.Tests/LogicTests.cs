using QuietOffice.Core;
using Xunit;

namespace QuietOffice.Tests;

public class CoverageTests
{
    static readonly Box Screen = Box.FromXywh(0, 0, 1920, 1080);

    [Fact]
    public void EmptyAndFull()
    {
        Assert.Equal(0, Coverage.Fraction(Screen, []));
        Assert.Equal(1, Coverage.Fraction(Screen, [Screen]));
        Assert.Equal(1, Coverage.Fraction(Screen, [Box.FromXywh(-50, -50, 3000, 2000)]));
    }

    [Fact]
    public void OverlapsCountOnce()
    {
        var left = Box.FromXywh(0, 0, 960, 1080);
        Assert.Equal(0.5, Coverage.Fraction(Screen, [left, left, Box.FromXywh(100, 100, 400, 400)]), 3);
        Assert.Equal(1, Coverage.Fraction(Screen, [left, Box.FromXywh(960, 0, 960, 1080)]), 3);
    }

    [Fact]
    public void MaximizedWindowAboveTaskbarPassesThreshold()
    {
        var maximized = Box.FromXywh(0, 0, 1920, 1032);   // 48 px taskbar left uncovered
        Assert.True(Coverage.Fraction(Screen, [maximized]) >= 0.90);
    }

    [Fact]
    public void SecondMonitorOffsetAndOutsideRects()
    {
        var right = Box.FromXywh(1920, -200, 2560, 1440);
        Assert.Equal(0, Coverage.Fraction(right, [Screen]));
        Assert.Equal(0.25, Coverage.Fraction(right, [Box.FromXywh(1920, -200, 1280, 720)]), 3);
        Assert.Equal(0, Coverage.Fraction(Box.FromXywh(0, 0, 0, 0), [Screen]));
    }
}

public class InsetsTests
{
    [Fact]
    public void BottomTaskbarAt100And150Percent()
    {
        var bounds = Box.FromXywh(0, 0, 1920, 1080);
        Assert.Equal("0,0,48,0", Insets.Compute(bounds, Box.FromXywh(0, 0, 1920, 1032), 1.0));
        Assert.Equal("0,0,32,0", Insets.Compute(bounds, Box.FromXywh(0, 0, 1920, 1032), 1.5));
    }

    [Fact]
    public void LeftAndTopTaskbarOnOffsetMonitor()
    {
        var bounds = Box.FromXywh(-2560, 0, 2560, 1440);
        Assert.Equal("0,0,0,80", Insets.Compute(bounds, Box.FromXywh(-2480, 0, 2480, 1440), 1.0));
        Assert.Equal("40,0,0,0", Insets.Compute(bounds, Box.FromXywh(-2560, 80, 2560, 1360), 2.0));
    }

    [Fact]
    public void NoNegativeEdgesAndBadScale()
    {
        var bounds = Box.FromXywh(0, 0, 100, 100);
        Assert.Equal("0,0,0,0", Insets.Compute(bounds, Box.FromXywh(-10, -10, 130, 130), 0));
    }
}

public class PageTests
{
    [Fact]
    public void UrlMatchesContract()
    {
        Assert.Equal("http://127.0.0.1:47100/?wallpaper=1&screen=1&inset=0,0,48,0&lang=ms", Page.Url(47100, 1, "0,0,48,0", "ms", false));
        Assert.Equal("http://127.0.0.1:47101/?wallpaper=1&screen=0&inset=0,0,0,0&lang=en&demo=1", Page.Url(47101, 0, "0,0,0,0", "xx", true));
    }

    [Theory]
    [InlineData("http://127.0.0.1:47100/", true)]
    [InlineData("http://127.0.0.1:47100/?wallpaper=1&screen=0", true)]
    [InlineData("http://127.0.0.1:47101/", false)]
    [InlineData("http://localhost:47100/", false)]
    [InlineData("https://127.0.0.1:47100/", false)]
    [InlineData("http://user@127.0.0.1:47100/", false)]
    [InlineData("http://127.0.0.1.example.com:47100/", false)]
    [InlineData("file:///C:/x.html", false)]
    [InlineData("about:blank", false)]
    [InlineData(null, false)]
    public void Allowlist(string? uri, bool allowed) => Assert.Equal(allowed, Page.IsAllowed(uri, 47100));

    [Fact]
    public void OptionsUseEnumsOnly()
    {
        Assert.Equal("{privacy:true,daypart:'night',lang:'ms'}", Page.Options(true, Daypart.Night, "ms"));
        Assert.Equal("{privacy:false,daypart:'auto',lang:'en'}", Page.Options(false, Daypart.Auto, "');alert(1);//"));
    }

    [Theory]
    [InlineData(null, "ms-MY", "ms")]
    [InlineData(null, "ms", "ms")]
    [InlineData(null, "en-GB", "en")]
    [InlineData("en", "ms-MY", "en")]
    [InlineData("ms", "fr-FR", "ms")]
    [InlineData("auto", "ms-BN", "ms")]
    [InlineData("de", "en-US", "en")]
    public void LangResolution(string? config, string culture, string expected) => Assert.Equal(expected, Lang.Resolve(config, culture));

    [Fact]
    public void NextMorningIsTomorrowAtSeven()
    {
        Assert.Equal(new DateTime(2026, 3, 2, 7, 0, 0), Schedule.NextMorning(new DateTime(2026, 3, 1, 23, 59, 0)));
        Assert.Equal(new DateTime(2026, 3, 2, 7, 0, 0), Schedule.NextMorning(new DateTime(2026, 3, 1, 0, 5, 0)));
    }
}

public class StateTests
{
    const string Sample = """
    {"agents":[
      {"id":1,"name":"api-gateway","mode":"active","waitingSince":null,"transcriptFound":true,"context":{"tokens":5,"max":9},
       "tools":[{"toolId":"t","toolName":"Bash","status":"Running command","runInBackground":false}],"subagents":[{},{}]},
      {"id":2,"name":"billing-service","mode":"permission","waitingSince":1764000000000,"subagents":[]},
      {"id":3,"name":"docs-site","mode":"input","waitingSince":1763999000000},
      {"id":4,"name":"blog","mode":"idle"},
      {"id":5,"name":"bad","mode":"sleeping"},
      {"id":6,"name":"num","mode":"1"},
      {"id":7,"mode":"active"}
    ],"today":{"day":"2026-03-01","sessions":4,"subtasks":7}}
    """;

    [Fact]
    public void KeepsWhitelistedFieldsOnly()
    {
        var s = ServerState.Parse(Sample)!;
        Assert.Equal(["api-gateway", "billing-service", "docs-site", "blog"], s.Agents.Select(a => a.Name));
        Assert.Equal(2, s.Agents[0].Subagents);
        Assert.Equal(AgentMode.Permission, s.Agents[1].Mode);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1764000000000), s.Agents[1].WaitingSince);
        Assert.Equal(new TodayStats(4, 7), s.Today);
        Assert.Equal(["docs-site", "billing-service"], s.Waiting.Select(a => a.Name));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"agents\":{}}")]
    public void InvalidIsNull(string json) => Assert.Null(ServerState.Parse(json));

    [Fact]
    public void NamesAreCleanedAndCapped()
    {
        var s = ServerState.Parse("{\"agents\":[{\"name\":\"a\\u0007b " + new string('x', 60) + "\",\"mode\":\"idle\"}]}")!;
        Assert.Equal(40, s.Agents[0].Name.Length);
        Assert.StartsWith("ab ", s.Agents[0].Name);
        Assert.Null(s.Today);
    }

    [Fact]
    public void MenuRows()
    {
        var s = ServerState.Parse(Sample)!;
        Assert.Equal("1 active · 1 idle · 2 waiting · 2 sub", MenuText.Summary(s, Strings.En));
        Assert.Equal("1 aktif · 1 rehat · 2 menunggu · 2 sub", MenuText.Summary(s, Strings.Ms));
        Assert.Equal("Server not reachable", MenuText.Summary(null, Strings.En));
        var now = DateTimeOffset.FromUnixTimeMilliseconds(1764000000000 + 3 * 60_000);
        var rows = MenuText.WaitRows(s, now, Strings.En);
        Assert.Equal(["⚠ docs-site — waiting for input · 19 min", "⚠ billing-service — waiting for permission · 3 min"], rows);
        Assert.Equal("Hari ini: 4 sesi · 7 subtugas", MenuText.Today(s.Today, Strings.Ms));
        Assert.Equal("Today: —", MenuText.Today(null, Strings.En));
    }

    [Fact]
    public void AtMostFiveWaitRowsThenMore()
    {
        var agents = Enumerable.Range(0, 8).Select(i => new AgentInfo($"alpha{i}", AgentMode.Input, DateTimeOffset.FromUnixTimeSeconds(i), 0)).ToList();
        var rows = MenuText.WaitRows(new ServerState(agents, null), DateTimeOffset.FromUnixTimeSeconds(60), Strings.Ms);
        Assert.Equal(6, rows.Count);
        Assert.StartsWith("⚠ alpha0 — menunggu arahan", rows[0]);
        Assert.Equal("dan 3 lagi", rows[5]);
    }
}

public class SettingsTests : IDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "qo-tests-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(dir)) Directory.Delete(dir, true); }

    [Fact]
    public void RoundTripAndAtomicWrite()
    {
        var path = Path.Combine(dir, "sub", "host-state.json");
        var s = new HostSettings { Enabled = false, PausedUntil = 1764000000, Privacy = true, PrivacyAuto = false, Daypart = Daypart.Night, NotifyWaiting = true, ServerScript = "x/server/server.mjs" };
        s.Save(path);
        s.Save(path);
        Assert.False(File.Exists(path + ".tmp"));
        var text = File.ReadAllText(path);
        Assert.Contains("\"daypart\": \"night\"", text);
        var back = HostSettings.Load(path);
        Assert.False(back.Enabled);
        Assert.Equal(1764000000, back.PausedUntil);
        Assert.True(back.Privacy);
        Assert.False(back.PrivacyAuto);
        Assert.Equal(Daypart.Night, back.Daypart);
        Assert.True(back.NotifyWaiting);
        Assert.Equal("x/server/server.mjs", back.ServerScript);
    }

    [Fact]
    public void MissingOrBrokenIsDefaults()
    {
        var d = HostSettings.Load(Path.Combine(dir, "none.json"));
        Assert.True(d.Enabled);
        Assert.Null(d.Privacy);
        Assert.True(d.PrivacyAuto);
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "bad.json"), "{nope");
        Assert.Equal(Daypart.Auto, HostSettings.Load(Path.Combine(dir, "bad.json")).Daypart);
    }

    [Fact]
    public void ConfigJson()
    {
        var c = AppConfig.Parse("""
        { "lang": "ms", // comment
          "aliases": { "infra": "Infra" },
          "privacy": { "default": true, "autoProcesses": ["CptHost.exe", "", 3, "Relay"] }, }
        """);
        Assert.Equal("ms", c.Lang);
        Assert.True(c.PrivacyDefault);
        Assert.Equal(["CptHost", "Relay"], c.AutoProcesses);
        Assert.Equal(AppConfig.Default, AppConfig.Parse("{\"lang\": 5}") with { AutoProcesses = AppConfig.Default.AutoProcesses });
        Assert.Null(AppConfig.Parse("{\"lang\":\"auto\"}").Lang);
        Assert.Equal(["CptHost"], AppConfig.Parse("garbage").AutoProcesses);
    }

    [Fact]
    public void FindsServerScriptWalkingUp()
    {
        var root = Path.Combine(dir, "repo");
        Directory.CreateDirectory(Path.Combine(root, "server"));
        File.WriteAllText(Path.Combine(root, "server", "server.mjs"), "");
        var deep = Path.Combine(root, "hosts", "windows", "bin", "Release", "net10.0-windows", "win-x64", "publish");
        Directory.CreateDirectory(deep);
        Assert.Equal(Path.Combine(root, "server", "server.mjs"), Locate.ServerScript(null, deep));
        Assert.Null(Locate.ServerScript(Path.Combine(dir, "missing.mjs"), deep));
        Assert.Null(Locate.ServerScript(null, deep, maxLevels: 2));
    }
}

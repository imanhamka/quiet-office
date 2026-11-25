# Adding a host

A host is a small native app that shows the page behind the desktop icons.
The server and the page are the same on every OS. Only the host changes.

Existing hosts:

| OS | Path | Stack | Status |
|---|---|---|---|
| macOS | `hosts/macos/` | Swift, AppKit, WKWebView | Stable |
| Windows | `hosts/windows/` | C#, .NET 10 WinForms, WebView2 | Experimental |
| Linux | `hosts/linux/` | Python 3, GTK 3, WebKit2GTK 4.1, GtkLayerShell | Experimental |

## What a host must do

1. Create one borderless window per screen, at desktop level, below the icons.
2. Make the window ignore input (click-through).
3. Load the page URL below in a web view.
4. Call the page's JS API to pause, resume, set insets and set options.
5. Show a menu bar or tray menu with the items below.
6. Read `GET /state` for the menu. Never call any other endpoint, never write anything to the server.

## Page URL

```text
http://127.0.0.1:<port>/?wallpaper=1&screen=<n>&inset=<t,r,b,l>&lang=<en|ms>
```

| Parameter | Value |
|---|---|
| `port` | `47100`, or `QUIET_OFFICE_PORT`. |
| `wallpaper=1` | Wallpaper mode: canvas only, no input. |
| `screen` | Zero-based screen index. Each screen picks a different part of the office. |
| `inset` | The screen's safe area in points or DIPs: top, right, bottom, left. Exclude the menu bar, Dock, taskbar or panels. |
| `lang` | `en` or `ms`. Omit it to let the page follow `config.json` and the browser. |
| `demo=1` | Optional. Fixture agents, no server data. Use it for screenshots. |

## JS API

The page exposes `window.__wallpaper` once it loads. Check that it exists before each call.

| Call | When |
|---|---|
| `pause()` | The desktop is at least 90% covered, the session is locked, the display sleeps, or the screensaver runs. |
| `resume(fps)` | Otherwise. Pass `12`. The page drops to 10 fps by itself when nobody walks. |
| `setInsets(t, r, b, l)` | When the safe area changes (Dock, taskbar, menu bar). No reload. |
| `setOptions({ privacy, daypart, lang })` | After each load and on every change. |

`setOptions` arguments:

| Key | Type | Default |
|---|---|---|
| `privacy` | boolean | `false` |
| `daypart` | `'auto'` \| `'day'` \| `'night'` | `'auto'` |
| `lang` | `'en'` \| `'ms'` | from the URL |

Build the argument from enums and booleans only. Never put a string from server data into injected JS.

## Menu items

Every host shows the same items, in English and Bahasa Melayu.

| Item | Behaviour |
|---|---|
| Wallpaper on/off | Off closes every window and frees the web view. The system wallpaper shows again. Saved across logins. |
| Pause ▸ 15 min / 1 hour / until 7:00 tomorrow / resume now | Timed pause, saved across restarts. |
| AGENTS section | One summary line, then up to 5 waiting agents, oldest first: name, permission or input, minutes waiting. Display only: no row does anything. |
| Today: n sessions · n subtasks | From `GET /state` `today`. |
| Privacy mode | Calls `setOptions({ privacy: true })`. Plus auto privacy during screen share, where the host can detect it. |
| Day/Night ▸ auto / day / night | Calls `setOptions({ daypart })`. |
| Notify when an agent waits > 2 min | Default off. No notification in privacy mode. |
| Reload | Clears the web view cache and reloads. |
| Advanced ▸ restart server, open logs | Restart uses the OS service manager with fixed arguments. No HTTP endpoint. |
| Quit | Ends the host until the next login. |

## Rules

- **Navigation:** allow `http://127.0.0.1:<port>/` and `about:blank` only. Refuse `window.open` and new windows.
- **Storage:** use a non-persistent web view data store where the platform has one.
- **Cache:** clear the web view cache before each load.
- **Config:** read `config.json` (see [config.md](config.md)), never write it. Missing or invalid means defaults.
- **Auto privacy:** match process names from `privacy.autoProcesses`. Never read window titles or screen contents.
- **Server:** the host does not need to start the server. Each install script registers the server as its own service.
- **Logs:** write to the OS log directory in [config.md](config.md). Log agent names only when debug is on.
- **Read-only:** no hooks, no writes under the Claude config directory, no input to sessions.

## Pause logic

The macOS host checks every 2 s:

1. Sum the area of normal app windows on each screen, clipped to the screen.
2. Pause when coverage is at least 0.90 (`QUIET_OFFICE_COVER_THRESHOLD` overrides it for tests).
3. Pause on lock, display sleep, system sleep and screensaver events.
4. Resume with `resume(12)` when none of these hold.

A new host can use OS events instead of polling where they exist. The result must match.

## Checklist for a new host

- [ ] Window below the desktop icons, on every virtual desktop.
- [ ] Click-through, no focus, no taskbar or Dock entry.
- [ ] URL with `screen`, `inset` and `lang`.
- [ ] `pause()` and `resume(12)` on the four pause conditions.
- [ ] `setInsets` on safe-area change.
- [ ] `setOptions` after each load and on change.
- [ ] Every menu item above, in EN and MS.
- [ ] Navigation allowlist and no pop-ups.
- [ ] A self-test or demo-mode check that runs in CI.
- [ ] Install and uninstall scripts under `scripts/<os>/`.
- [ ] A CI job in `.github/workflows/ci.yml`.

#!/usr/bin/env python3
"""Quiet Office Linux host (experimental): the office page as a desktop-level wallpaper.

One window per monitor shows http://127.0.0.1:<port>/?wallpaper=1&screen=<n>&inset=<t,r,b,l>&lang=<en|ms>
and tells the page to pause or resume. The host is read-only toward Claude sessions: it only
reads GET /state from the local server and never writes anything outside its own state file.

Placement:
  Wayland + wlr-layer-shell (wlroots, Hyprland, KDE): background layer on every output.
  X11: undecorated window with the DESKTOP type hint, kept below, sticky, no input.
  GNOME on Wayland has no layer-shell: the host exits unless QUIET_OFFICE_FORCE=1.

Env: QUIET_OFFICE_PORT (default 47100; a first CLI argument wins), QUIET_OFFICE_DEBUG=1 (devtools,
coverage log), QUIET_OFFICE_COVER_THRESHOLD (0..1, testing), QUIET_OFFICE_FORCE=1.
WebKit reads WEBKIT_DISABLE_DMABUF_RENDERER itself; the host never overrides it. On NVIDIA
proprietary drivers a blank or frozen window is often fixed by WEBKIT_DISABLE_DMABUF_RENDERER=1.
Signals: SIGUSR1 toggles a manual pause, SIGUSR2 re-reads host-state.json and reloads.
"""
import argparse
import datetime
import fcntl
import importlib
import json
import os
import signal
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402


def optional(name, version):
    try:
        gi.require_version(name, version)
        return importlib.import_module("gi.repository." + name)
    except (ValueError, ImportError):
        return None


try:
    import cairo
except ImportError:
    cairo = None

ENV = os.environ
DEBUG = ENV.get("QUIET_OFFICE_DEBUG") == "1"
COVER_THRESHOLD = float(ENV.get("QUIET_OFFICE_COVER_THRESHOLD") or 0.90)
RESUME_FPS = 12
CHECK_S, STATE_S, RETRY_S = 2, 10, 5
MAX_WAIT_ROWS = 5
BACKGROUND = "#141216"
SERVER_UNIT = "quiet-office-server.service"
HOME = os.path.expanduser("~")
CONFIG_DIR = os.path.join(ENV.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "quiet-office")
STATE_FILE = os.path.join(CONFIG_DIR, "host-state.json")
LOG_DIR = os.path.join(ENV.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state"), "quiet-office")


def log(line):
    print(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {line}", flush=True)


def warn(line):
    print(f"quiet-office: {line}", file=sys.stderr, flush=True)


# ── Strings (EN / MS) ─────────────────────────────────────────────────────────

STRINGS = {
    "en": {
        "on": "Wallpaper on", "pause": "Pause", "p15": "15 minutes", "p60": "1 hour",
        "ptomorrow": "Until tomorrow (7:00)", "resume": "Resume now", "paused_until": "Paused until {t}",
        "paused_manual": "Paused (manual)", "agents": "AGENTS", "active": "{n} active", "idle": "{n} idle",
        "waiting": "{n} waiting", "sub": "{n} sub", "wait_perm": "waiting for permission",
        "wait_input": "waiting for input", "more": "and {n} more", "today": "Today: {s} sessions · {t} subtasks",
        "today_none": "Today: —", "server_down": "Server unreachable", "privacy": "Privacy mode",
        "privacy_auto": "Auto during screen share", "daypart": "Day / Night", "auto": "Follow the clock",
        "day": "Day", "night": "Night", "notify": "Notify when an agent waits > 2 min", "reload": "Reload",
        "advanced": "Advanced", "restart": "Restart server", "logs": "Open logs", "quit": "Quit",
    },
    "ms": {
        "on": "Wallpaper hidup", "pause": "Jeda", "p15": "15 minit", "p60": "1 jam",
        "ptomorrow": "Hingga esok pagi (7:00)", "resume": "Sambung sekarang", "paused_until": "Dijeda hingga {t}",
        "paused_manual": "Dijeda (manual)", "agents": "EJEN", "active": "{n} aktif", "idle": "{n} rehat",
        "waiting": "{n} menunggu", "sub": "{n} sub", "wait_perm": "menunggu kebenaran",
        "wait_input": "menunggu arahan", "more": "dan {n} lagi", "today": "Hari ini: {s} sesi · {t} subtugas",
        "today_none": "Hari ini: —", "server_down": "Pelayan tidak dapat dihubungi", "privacy": "Mod privasi",
        "privacy_auto": "Auto semasa kongsi skrin", "daypart": "Siang / Malam", "auto": "Ikut jam",
        "day": "Siang", "night": "Malam", "notify": "Beritahu bila ejen menunggu > 2 min", "reload": "Muat semula",
        "advanced": "Lanjutan", "restart": "Mulakan semula pelayan", "logs": "Buka folder log", "quit": "Keluar",
    },
}


def read_config():
    """config.json is optional; missing or invalid means defaults. The host never writes it."""
    try:
        with open(os.path.join(CONFIG_DIR, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def resolve_lang(cfg):
    if cfg.get("lang") in ("en", "ms"):
        return cfg["lang"]
    for key in ("LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"):
        value = ENV.get(key)
        if value:
            return "ms" if value.lower().startswith("ms") else "en"
    return "en"


def auto_processes(cfg):
    privacy = cfg.get("privacy") if isinstance(cfg.get("privacy"), dict) else {}
    names = privacy.get("autoProcesses", ["CptHost"])
    # /proc/<pid>/comm holds at most 15 characters.
    return {n[:15] for n in names if isinstance(n, str) and n} if isinstance(names, list) else set()


# ── Saved host state (host-state.json, 0600, atomic) ─────────────────────────

STATE_DEFAULTS = {"enabled": True, "pausedUntil": None, "privacy": False, "privacyAuto": True,
                  "daypart": "auto", "notifyWaiting": False}


def load_state():
    state = dict(STATE_DEFAULTS)
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return state
    if not isinstance(raw, dict):
        return state
    for key in ("enabled", "privacy", "privacyAuto", "notifyWaiting"):
        if isinstance(raw.get(key), bool):
            state[key] = raw[key]
    if isinstance(raw.get("pausedUntil"), (int, float)) and not isinstance(raw.get("pausedUntil"), bool):
        state["pausedUntil"] = float(raw["pausedUntil"])
    if raw.get("daypart") in ("auto", "day", "night"):
        state["daypart"] = raw["daypart"]
    return state


def save_state(state):
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=CONFIG_DIR, prefix=".host-state.", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, STATE_FILE)
    except OSError as e:
        warn(f"cannot save {STATE_FILE}: {e}")
        try:
            os.unlink(tmp)
        except OSError:
            pass


# ── Placement ─────────────────────────────────────────────────────────────────

LayerShell = optional("GtkLayerShell", "0.1")
GNOME_MESSAGE = """Quiet Office: this Wayland session has no wlr-layer-shell, so the host cannot place a
desktop-level window. GNOME Shell (Mutter) does not offer layer-shell.
Options:
  - Log in to an X11 session, or a compositor with layer-shell (KDE Plasma, Sway, Hyprland).
  - Try GDK_BACKEND=x11 (XWayland). Unconfirmed: Mutter can show the window above the desktop.
  - Set QUIET_OFFICE_FORCE=1 to open a plain undecorated window anyway."""


def detect_placement(display):
    kind = type(display).__name__
    if "X11" in kind:
        return "x11"
    if "Wayland" in kind:
        supported = LayerShell is not None and (
            LayerShell.is_supported() if hasattr(LayerShell, "is_supported")
            else "GNOME" not in ENV.get("XDG_CURRENT_DESKTOP", "").upper())
        return "layer-shell" if supported else "wayland-unsupported"
    return "unknown"


def place_layer_shell(win, monitor):
    L = LayerShell
    L.init_for_window(win)
    L.set_layer(win, L.Layer.BACKGROUND)
    L.set_namespace(win, "quiet-office")
    L.set_monitor(win, monitor)
    for edge in (L.Edge.TOP, L.Edge.BOTTOM, L.Edge.LEFT, L.Edge.RIGHT):
        L.set_anchor(win, edge, True)
    # 0 = reserve nothing and stay inside other surfaces' exclusive zones, so the page gets inset 0.
    L.set_exclusive_zone(win, 0)
    if hasattr(L, "set_keyboard_mode"):
        L.set_keyboard_mode(win, L.KeyboardMode.NONE)
    else:
        L.set_keyboard_interactivity(win, False)


def place_x11(win, geo):
    win.set_decorated(False)
    win.set_type_hint(Gdk.WindowTypeHint.DESKTOP)
    win.set_keep_below(True)
    win.stick()
    win.set_skip_taskbar_hint(True)
    win.set_skip_pager_hint(True)
    win.set_accept_focus(False)
    win.set_focus_on_map(False)
    win.move(geo.x, geo.y)
    win.set_default_size(geo.width, geo.height)


def insets_of(monitor, placement):
    """Safe area as (top, right, bottom, left) in logical px. X11 work area comes from _NET_WORKAREA."""
    if placement == "layer-shell":
        return (0, 0, 0, 0)
    g, w = monitor.get_geometry(), monitor.get_workarea()
    return (max(0, w.y - g.y), max(0, g.x + g.width - w.x - w.width),
            max(0, g.y + g.height - w.y - w.height), max(0, w.x - g.x))


def coverage(screen, rects, cols=64, rows=36):
    """Covered fraction of screen (x, y, w, h); a grid cell counts when its centre is inside a rect."""
    sx, sy, sw, sh = screen
    if sw <= 0 or sh <= 0:
        return 0.0
    cw, ch = sw / cols, sh / rows
    grid = set()
    for x, y, w, h in rects:
        x0, y0, x1, y1 = max(x, sx), max(y, sy), min(x + w, sx + sw), min(y + h, sy + sh)
        if x1 <= x0 or y1 <= y0:
            continue
        c0 = max(0, int(-(-((x0 - sx) / cw - 0.5) // 1)))
        c1 = min(cols - 1, int(-(-((x1 - sx) / cw - 0.5) // 1)) - 1)
        r0 = max(0, int(-(-((y0 - sy) / ch - 0.5) // 1)))
        r1 = min(rows - 1, int(-(-((y1 - sy) / ch - 0.5) // 1)) - 1)
        grid.update((r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1))
    return len(grid) / (cols * rows)


def processes_running(names):
    if not names:
        return False
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                with open(f"/proc/{pid}/comm", encoding="utf-8", errors="replace") as f:
                    if f.read().strip() in names:
                        return True
            except OSError:
                pass
    return False


# ── One wallpaper window per monitor ─────────────────────────────────────────

FRAME_PROBE = """(function(){var n=0,raf=window.requestAnimationFrame.bind(window);
window.requestAnimationFrame=function(cb){return raf(function(t){n++;cb(t)})};
window.__quietOfficeFrames=function(){return n}})();"""


def guarded(call):
    return f"(function(){{var w=window.__wallpaper;if(!w)return false;w.{call};return true}})()"


class Wallpaper:
    def __init__(self, host, monitor, index):
        self.host, self.monitor, self.index = host, monitor, index
        self.loaded = self.failing = self.closed = self.sending = False
        self.sent_paused = self.sent_insets = self.sent_options = None
        self.want_paused, self.want_reason = False, ""
        self.retry_id = 0
        geo = monitor.get_geometry()
        self.url = host.page_url(index, insets_of(monitor, host.placement))

        self.win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL, title="Quiet Office")
        if host.placement == "layer-shell":
            place_layer_shell(self.win, monitor)
        else:
            place_x11(self.win, geo)
        self.win.get_style_context().add_provider(host.css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        if cairo is not None:
            self.win.input_shape_combine_region(cairo.Region())  # clicks pass through to the desktop

        self.web = WebKit2.WebView(web_context=host.context, settings=host.settings,
                                   user_content_manager=host.content_manager())
        rgba = Gdk.RGBA()
        rgba.parse(BACKGROUND)
        self.web.set_background_color(rgba)
        self.web.connect("decide-policy", self.on_policy)
        self.web.connect("create", lambda *_: None)       # no new windows, ever
        self.web.connect("context-menu", lambda *_: True)
        self.web.connect("load-changed", self.on_load_changed)
        self.web.connect("load-failed", self.on_load_failed)
        self.web.connect("web-process-terminated", self.on_terminated)
        self.win.add(self.web)
        self.win.show_all()
        if host.placement != "layer-shell":
            self.win.resize(geo.width, geo.height)
            self.win.move(geo.x, geo.y)
        self.load()

    def load(self):
        if self.retry_id:
            GLib.source_remove(self.retry_id)
            self.retry_id = 0
        self.loaded = False
        self.sent_paused = None
        self.web.load_uri(self.url)

    def retry(self, seconds):
        if self.retry_id:
            GLib.source_remove(self.retry_id)

        def fire():
            self.retry_id = 0
            if not self.closed:
                self.load()
            return False
        self.retry_id = GLib.timeout_add_seconds(seconds, fire)

    def failed(self, what):
        self.loaded = False
        if not self.failing:
            log(f"screen={self.index} load failed ({what}); retrying every {RETRY_S}s")
            self.failing = True
        self.retry(RETRY_S)

    def on_policy(self, web, decision, kind):
        T = WebKit2.PolicyDecisionType
        if kind == T.NEW_WINDOW_ACTION:
            decision.ignore()
            return True
        if kind == T.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if not uri.startswith(self.host.origin + "/"):
                log(f"screen={self.index} blocked navigation to a non-local URL")
                decision.ignore()
                return True
        elif kind == T.RESPONSE:
            main = getattr(decision, "is_main_frame_main_resource", lambda: True)()
            status = decision.get_response().get_status_code()
            if main and status >= 400:
                decision.ignore()
                self.failed(f"HTTP {status}")
                return True
        return False

    def on_load_failed(self, web, event, uri, error):
        # Our own decision.ignore() lands here as "interrupted by policy change"; failed() already ran.
        if error.matches(WebKit2.PolicyError.quark(), WebKit2.PolicyError.FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE):
            return True
        self.failed(error.message)
        return True

    def on_load_changed(self, web, event):
        if event != WebKit2.LoadEvent.FINISHED or self.retry_id or self.closed:
            return
        log(f"screen={self.index} loaded {self.url}")
        self.failing = False
        self.loaded = True
        self.sent_paused = self.sent_insets = self.sent_options = None
        self.apply(self.want_paused, self.want_reason)
        self.update_insets()
        self.update_options()
        self.host.page_loaded(self)

    def on_terminated(self, web, reason):
        log(f"screen={self.index} web process terminated ({reason.value_nick}); reloading")
        self.loaded = False
        self.retry(1)

    def evaluate(self, script, done):
        """Runs `script` and calls done(value or None) with the JSC result."""
        def finish(web, result):
            try:
                if hasattr(web, "evaluate_javascript_finish"):
                    done(web.evaluate_javascript_finish(result))
                else:
                    done(web.run_javascript_finish(result).get_js_value())
            except GLib.Error as e:
                if DEBUG:
                    log(f"debug screen={self.index} js error: {e.message}")
                done(None)
        if hasattr(self.web, "evaluate_javascript"):
            self.web.evaluate_javascript(script, -1, None, None, None, finish)
        else:
            self.web.run_javascript(script, None, finish)

    def call(self, js_call, on_ok):
        self.evaluate(guarded(js_call), lambda v: on_ok() if v is not None and v.is_boolean() and v.to_boolean() else None)

    def update_insets(self):
        now = insets_of(self.monitor, self.host.placement)
        if not self.loaded or now == self.sent_insets:
            return

        def ok():
            if self.sent_insets is not None:
                log(f"screen={self.index} insets={','.join(map(str, now))}")
            self.sent_insets = now
        self.call("setInsets({},{},{},{})".format(*now), ok)

    def update_options(self):
        now = self.host.page_options()
        if not self.loaded or now == self.sent_options:
            return

        def ok():
            log(f"screen={self.index} options={now}")
            self.sent_options = now
        self.call(f"setOptions({now})", ok)

    def apply(self, paused, reason):
        self.want_paused, self.want_reason = paused, reason
        if not self.loaded or self.sending or self.sent_paused == paused:
            return
        self.sending = True

        def done(value):
            self.sending = False
            if value is not None and value.is_boolean() and value.to_boolean():
                self.sent_paused = paused
                log(f"screen={self.index} {'pause' if paused else 'resume'} reason={reason}")
            elif DEBUG:
                log(f"debug screen={self.index} window.__wallpaper not ready")
            if self.sent_paused is not None and self.want_paused != self.sent_paused:
                self.apply(self.want_paused, self.want_reason)
        self.evaluate(guarded("pause()" if paused else f"resume({RESUME_FPS})"), done)

    def close(self):
        self.closed = True
        if self.retry_id:
            GLib.source_remove(self.retry_id)
            self.retry_id = 0
        self.web.stop_loading()
        self.win.destroy()


# ── Host: windows, pause reasons, D-Bus watchers ─────────────────────────────

class Host:
    def __init__(self, port, placement, selftest=None):
        self.port, self.placement, self.selftest = port, placement, selftest
        self.origin = f"http://127.0.0.1:{port}"
        self.config = read_config()
        self.lang = resolve_lang(self.config)
        self.text = STRINGS[self.lang]
        self.state = dict(STATE_DEFAULTS) if selftest else load_state()
        self.walls, self.reasons = [], set()
        self.running, self.check_id, self.rebuild_id = False, 0, 0
        self.sharing = False
        self.agents, self.today, self.server_up, self.fetching = [], None, False, False
        self.notified = set()
        self.session_proxy = None
        self.wnck_screen = self.init_wnck() if placement == "x11" else None
        self.tray = None
        self.display = Gdk.Display.get_default()

        self.context = WebKit2.WebContext.new_ephemeral()  # nothing persists: no cookies, storage, disk cache
        # No memory cache either, so a rebuilt layout or sprite shows on the next reload.
        self.context.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)
        manager = self.context.get_website_data_manager()
        if hasattr(manager, "set_network_proxy_settings"):
            manager.set_network_proxy_settings(WebKit2.NetworkProxyMode.NO_PROXY, None)
        # WebKitGTK has no setting for hidden-page throttling; it throttles only unmapped views.
        self.settings = WebKit2.Settings(
            enable_developer_extras=DEBUG, enable_write_console_messages_to_stdout=DEBUG,
            javascript_can_open_windows_automatically=False, javascript_can_access_clipboard=False,
            enable_page_cache=False, enable_dns_prefetching=False,
            enable_html5_database=False, enable_media_stream=False, enable_webrtc=False)
        self.css = Gtk.CssProvider()
        self.css.load_from_data(f"window {{ background-color: {BACKGROUND}; }}".encode())

    def content_manager(self):
        manager = WebKit2.UserContentManager()
        if self.selftest:
            manager.add_script(WebKit2.UserScript.new(
                FRAME_PROBE, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                WebKit2.UserScriptInjectionTime.START, None, None))
        return manager

    def page_url(self, index, insets):
        query = {"wallpaper": "1", "screen": str(index), "inset": ",".join(map(str, insets)), "lang": self.lang}
        if self.selftest:
            query["demo"] = "1"
        return f"{self.origin}/?{urllib.parse.urlencode(query, safe=',')}"

    def page_options(self):
        """Built from enums and booleans only, never from data strings."""
        privacy = "true" if self.privacy_on else "false"
        return f"{{privacy:{privacy},daypart:'{self.state['daypart']}',lang:'{self.lang}'}}"

    @property
    def privacy_on(self):
        return self.state["privacy"] or self.sharing

    def save(self):
        if not self.selftest:
            save_state(self.state)

    # Windows

    def start(self):
        if self.running:
            return
        log("wallpaper on")
        self.running = True
        self.build_windows()
        self.check_id = GLib.timeout_add_seconds(CHECK_S, lambda: self.check() or True)
        self.check()

    def stop(self):
        if not self.running:
            return
        log(f"wallpaper off: closing {len(self.walls)} window(s)")
        self.running = False
        GLib.source_remove(self.check_id)
        for wall in self.walls:
            wall.close()
        self.walls = []

    def apply_enabled(self):
        self.start() if self.state["enabled"] else self.stop()
        self.refresh_ui()

    def build_windows(self):
        for wall in self.walls:
            wall.close()
        n = self.display.get_n_monitors()
        self.walls = [Wallpaper(self, self.display.get_monitor(i), i) for i in range(n)]
        log(f"placement={self.placement} monitors={n}")

    def monitors_changed(self, *_):
        if self.rebuild_id:
            GLib.source_remove(self.rebuild_id)

        def rebuild():
            self.rebuild_id = 0
            if self.running:
                log("monitors changed; rebuilding")
                self.build_windows()
                self.check()
            return False
        self.rebuild_id = GLib.timeout_add_seconds(1, rebuild)

    def reload(self, *_):
        log("reload all")
        for wall in self.walls:
            wall.load()

    def page_loaded(self, wall):
        if self.selftest:
            self.selftest.page_loaded(wall)

    # Pause reasons

    def set_reason(self, reason, on):
        (self.reasons.add if on else self.reasons.discard)(reason)
        if DEBUG:
            log(f"debug reason {reason}={on}")
        self.check()

    def check(self):
        if self.session_proxy is not None:
            locked = self.session_proxy.get_cached_property("LockedHint")
            if locked is not None:
                (self.reasons.add if locked.get_boolean() else self.reasons.discard)("locked")
        until = self.state["pausedUntil"]
        if until and until > time.time():
            self.reasons.add("timed")
        else:
            if until:
                self.state["pausedUntil"] = None
                self.save()
                log("timed pause over")
            self.reasons.discard("timed")
        sharing = self.state["privacyAuto"] and processes_running(auto_processes(self.config))
        if sharing != self.sharing:
            self.sharing = sharing
            log("screen share detected: privacy on" if sharing else "screen share over")
            self.refresh_ui()
        windows = self.x11_windows()
        for wall in self.walls:
            why = set(self.reasons)
            covered = None
            if windows is not None:
                g, scale = wall.monitor.get_geometry(), wall.monitor.get_scale_factor()
                covered = coverage((g.x * scale, g.y * scale, g.width * scale, g.height * scale), windows)
                if covered >= COVER_THRESHOLD:
                    why.add("covered")
            if DEBUG:
                log(f"debug screen={wall.index} coverage={covered} reasons={sorted(why)}")
            wall.update_insets()
            wall.update_options()
            pct = "n/a" if covered is None else f"{covered * 100:.1f}%"
            wall.apply(bool(why), (",".join(sorted(why)) if why else "visible") + f" coverage={pct}")

    def init_wnck(self):
        Wnck = optional("Wnck", "3.0")
        if Wnck is None:
            log("libwnck not found: no pause when windows cover the desktop")
            return None
        screen = Wnck.Screen.get_default()
        if screen is not None:
            screen.force_update()
        self.wnck = Wnck
        return screen

    def x11_windows(self):
        """Visible normal windows from _NET_CLIENT_LIST_STACKING, in X pixels; None when unknown."""
        if self.wnck_screen is None:
            return None
        W = self.wnck.WindowType
        workspace = self.wnck_screen.get_active_workspace()
        rects = []
        for w in self.wnck_screen.get_windows_stacked() or []:
            if w.get_window_type() not in (W.NORMAL, W.DIALOG, W.UTILITY) or w.is_minimized():
                continue
            if workspace is not None and not w.is_visible_on_workspace(workspace):
                continue
            rects.append(tuple(w.get_geometry()))
        return rects

    def watch_dbus(self):
        try:
            system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
            manager = Gio.DBusProxy.new_sync(system, Gio.DBusProxyFlags.NONE, None, "org.freedesktop.login1",
                                             "/org/freedesktop/login1", "org.freedesktop.login1.Manager", None)
            manager.connect("g-signal", self.on_logind_signal)
            path = self.logind_session_path(manager, system)
            self.session_proxy = Gio.DBusProxy.new_sync(system, Gio.DBusProxyFlags.NONE, None,
                                                        "org.freedesktop.login1", path,
                                                        "org.freedesktop.login1.Session", None)
            self.session_proxy.connect("g-signal", self.on_logind_signal)
            log(f"logind session {path}")
        except GLib.Error as e:
            log(f"logind not available ({e.message}): no lock or sleep pause")
        try:
            session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            for iface in ("org.freedesktop.ScreenSaver", "org.gnome.ScreenSaver"):
                session.signal_subscribe(None, iface, "ActiveChanged", None, None, Gio.DBusSignalFlags.NONE,
                                         lambda *a: self.set_reason("screensaver", a[5].unpack()[0]))
            self.session_bus = session
        except GLib.Error as e:
            self.session_bus = None
            log(f"session bus not available ({e.message}): no screensaver pause, no notifications")

    @staticmethod
    def logind_session_path(manager, system):
        sid = ENV.get("XDG_SESSION_ID")
        if sid:
            try:
                return manager.call_sync("GetSession", GLib.Variant("(s)", (sid,)), 0, 2000, None).unpack()[0]
            except GLib.Error:
                pass
        try:
            # Autostarted apps can run outside the login session scope; the user's display session is the one.
            reply = system.call_sync("org.freedesktop.login1", "/org/freedesktop/login1/user/self",
                                     "org.freedesktop.DBus.Properties", "Get",
                                     GLib.Variant("(ss)", ("org.freedesktop.login1.User", "Display")),
                                     None, 0, 2000, None)
            path = reply.unpack()[0][1]
            if path and path != "/":
                return path
        except GLib.Error:
            pass
        return "/org/freedesktop/login1/session/auto"

    def on_logind_signal(self, proxy, sender, name, params):
        if name == "Lock":
            self.set_reason("locked", True)
        elif name == "Unlock":
            self.set_reason("locked", False)
        elif name == "PrepareForSleep":
            self.set_reason("system-sleep", params.unpack()[0])

    # Menu actions

    def toggle_enabled(self):
        self.state["enabled"] = not self.state["enabled"]
        self.save()
        log("enabled from menu" if self.state["enabled"] else "disabled from menu")
        self.apply_enabled()

    def pause_for(self, minutes):
        now = datetime.datetime.now()
        if minutes is None:
            until = (now + datetime.timedelta(days=1)).replace(hour=7, minute=0, second=0, microsecond=0)
        else:
            until = now + datetime.timedelta(minutes=minutes)
        self.state["pausedUntil"] = until.timestamp()
        self.save()
        log(f"timed pause until {until.isoformat(timespec='minutes')}")
        self.check()
        self.refresh_ui()

    def resume_now(self):
        self.state["pausedUntil"] = None
        self.save()
        self.reasons -= {"timed", "manual"}
        log("resumed from menu")
        self.check()
        self.refresh_ui()

    def set_option(self, key, value):
        self.state[key] = value
        self.save()
        log(f"{key}={value}")
        self.sync_options()

    def sync_options(self):
        for wall in self.walls:
            wall.update_options()
        self.refresh_ui()

    def restart_server(self):
        try:
            proc = Gio.Subprocess.new(["systemctl", "--user", "restart", SERVER_UNIT], Gio.SubprocessFlags.NONE)
        except GLib.Error as e:
            log(f"server restart failed: {e.message}")
            return

        def done(p, result):
            p.wait_finish(result)
            log(f"server restart exit={p.get_exit_status()}")
            GLib.timeout_add_seconds(2, lambda: self.fetch_state() and False)
        proc.wait_async(None, done)

    def open_logs(self):
        os.makedirs(LOG_DIR, mode=0o700, exist_ok=True)
        try:
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(LOG_DIR, None), None)
        except GLib.Error as e:
            log(f"open logs failed: {e.message}")

    def refresh_ui(self):
        if self.tray:
            self.tray.refresh()

    # Agent data (GET /state, whitelisted fields)

    def fetch_state(self):
        if self.fetching:
            return
        self.fetching = True
        url = f"{self.origin}/state"

        def work():
            agents = today = None
            try:
                # No proxy: a http_proxy variable must never send this request off the machine.
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(urllib.request.Request(url, method="GET"), timeout=2) as res:
                    if res.status == 200:
                        root = json.loads(res.read(2_000_000))
                        agents, today = parse_agents(root), parse_today(root)
            except (OSError, ValueError):
                pass
            GLib.idle_add(self.state_fetched, agents, today)
        threading.Thread(target=work, daemon=True).start()

    def state_fetched(self, agents, today):
        self.fetching = False
        self.server_up = agents is not None
        self.agents, self.today = agents or [], today
        self.notify_long_waits()
        self.refresh_ui()
        return False

    @property
    def waiting(self):
        rows = [a for a in self.agents if a["mode"] in ("permission", "input")]
        return sorted(rows, key=lambda a: a["waitingSince"] or float("inf"))

    def notify_long_waits(self):
        keys = {f"{a['name']}|{a['waitingSince']}" for a in self.waiting if a["waitingSince"]}
        self.notified &= keys
        if not self.state["notifyWaiting"] or self.privacy_on or self.session_bus is None:
            return
        now_ms = time.time() * 1000
        for a in self.waiting:
            key = f"{a['name']}|{a['waitingSince']}"
            if not a["waitingSince"] or now_ms - a["waitingSince"] < 120_000 or key in self.notified:
                continue
            self.notified.add(key)
            what = self.text["wait_perm" if a["mode"] == "permission" else "wait_input"]
            body = GLib.markup_escape_text(f"{a['name']} {what}")  # servers may render body markup
            self.session_bus.call("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                                  "org.freedesktop.Notifications", "Notify",
                                  GLib.Variant("(susssasa{sv}i)", ("Quiet Office", 0, "dialog-warning",
                                                                   "Quiet Office", body, [], {}, -1)),
                                  None, Gio.DBusCallFlags.NONE, 2000, None, None)
            log(f"notified wait agent={a['name']}")


MODES = ("active", "idle", "permission", "input")


def parse_agents(root):
    if not isinstance(root, dict) or not isinstance(root.get("agents"), list):
        return None
    out = []
    for a in root["agents"]:
        if not isinstance(a, dict) or not isinstance(a.get("name"), str) or a.get("mode") not in MODES:
            continue
        since = a.get("waitingSince")
        since = float(since) if isinstance(since, (int, float)) and not isinstance(since, bool) else None
        subs = len(a["subagents"]) if isinstance(a.get("subagents"), list) else 0
        name = "".join(ch for ch in a["name"][:40] if ch.isprintable())
        out.append({"name": name, "mode": a["mode"], "waitingSince": since, "subagents": subs})
    return out


def parse_today(root):
    t = root.get("today") if isinstance(root, dict) else None
    if not isinstance(t, dict):
        return None
    s, n = t.get("sessions"), t.get("subtasks")
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (s, n)):
        return None
    return max(0, s), max(0, n)


# ── Tray (AppIndicator) ──────────────────────────────────────────────────────

class Tray:
    def __init__(self, host, indicator_mod):
        self.host, self.t, self.updating = host, host.text, False
        AI = indicator_mod
        self.ind = AI.Indicator.new("quiet-office", "image-x-generic", AI.IndicatorCategory.APPLICATION_STATUS)
        self.ind.set_status(AI.IndicatorStatus.ACTIVE)
        self.ind.set_title("Quiet Office")
        t, menu = self.t, Gtk.Menu()

        self.toggle = self.check(menu, t["on"], host.toggle_enabled)
        pause_menu = Gtk.Menu()
        for label, minutes in ((t["p15"], 15), (t["p60"], 60), (t["ptomorrow"], None)):
            self.item(pause_menu, label, lambda m=minutes: host.pause_for(m))
        pause_menu.append(Gtk.SeparatorMenuItem())
        self.resume_item = self.item(pause_menu, t["resume"], host.resume_now)
        self.pause_item = self.item(menu, t["pause"])
        self.pause_item.set_submenu(pause_menu)

        menu.append(Gtk.SeparatorMenuItem())
        self.row(menu, t["agents"])
        self.summary = self.row(menu, "")
        self.wait_rows = [self.row(menu, "") for _ in range(MAX_WAIT_ROWS + 1)]
        self.today = self.row(menu, "")

        menu.append(Gtk.SeparatorMenuItem())
        self.privacy = self.check(menu, t["privacy"], lambda: host.set_option("privacy", not host.state["privacy"]))
        self.privacy_auto = self.check(menu, "    " + t["privacy_auto"],
                                       lambda: host.set_option("privacyAuto", not host.state["privacyAuto"]))
        day_menu, group, self.dayparts = Gtk.Menu(), None, {}
        for mode in ("auto", "day", "night"):
            radio = Gtk.RadioMenuItem.new_with_label_from_widget(group, t[mode])
            group = radio
            radio.connect("toggled", lambda w, m=mode: (not self.updating and w.get_active()
                                                         and host.set_option("daypart", m)))
            day_menu.append(radio)
            self.dayparts[mode] = radio
        self.item(menu, t["daypart"]).set_submenu(day_menu)
        self.notify = self.check(menu, t["notify"],
                                 lambda: host.set_option("notifyWaiting", not host.state["notifyWaiting"]))

        menu.append(Gtk.SeparatorMenuItem())
        self.reload_item = self.item(menu, t["reload"], host.reload)
        more = Gtk.Menu()
        self.item(more, t["restart"], host.restart_server)
        self.item(more, t["logs"], host.open_logs)
        self.item(menu, t["advanced"]).set_submenu(more)
        menu.append(Gtk.SeparatorMenuItem())
        self.item(menu, t["quit"], Gtk.main_quit)
        menu.show_all()
        self.ind.set_menu(menu)
        self.refresh()

    def item(self, menu, label, action=None):
        it = Gtk.MenuItem(label=label)
        if action:
            it.connect("activate", lambda *_: action())
        menu.append(it)
        return it

    def check(self, menu, label, action):
        it = Gtk.CheckMenuItem(label=label)
        # set_active() also fires "toggled"; only a click acts.
        it.connect("toggled", lambda *_: None if self.updating else action())
        menu.append(it)
        return it

    def row(self, menu, label):
        it = Gtk.MenuItem(label=label)
        it.set_sensitive(False)  # display only
        menu.append(it)
        return it

    def refresh(self):
        h, t = self.host, self.t
        self.updating = True
        try:
            on = h.state["enabled"]
            self.toggle.set_active(on)
            until, manual = h.state["pausedUntil"], "manual" in h.reasons
            if until and until > time.time():
                d = datetime.datetime.fromtimestamp(until)
                fmt = "%H:%M" if d.date() == datetime.date.today() else "%a %H:%M"
                self.pause_item.set_label(t["paused_until"].format(t=d.strftime(fmt)))
            else:
                self.pause_item.set_label(t["paused_manual"] if manual else t["pause"])
            self.pause_item.set_sensitive(on)
            self.resume_item.set_sensitive(bool(until) or manual)
            self.reload_item.set_sensitive(on)
            self.privacy.set_active(h.state["privacy"])
            self.privacy_auto.set_active(h.state["privacyAuto"])
            self.dayparts[h.state["daypart"]].set_active(True)
            self.notify.set_active(h.state["notifyWaiting"])
            self.today.set_label(t["today"].format(s=h.today[0], t=h.today[1]) if h.today else t["today_none"])
            waiting = h.waiting
            if not h.server_up:
                self.summary.set_label(t["server_down"])
            else:
                parts = [t["active"].format(n=sum(a["mode"] == "active" for a in h.agents)),
                         t["idle"].format(n=sum(a["mode"] == "idle" for a in h.agents))]
                if waiting:
                    parts.append(t["waiting"].format(n=len(waiting)))
                parts.append(t["sub"].format(n=sum(a["subagents"] for a in h.agents)))
                self.summary.set_label(" · ".join(parts))
            now_ms = time.time() * 1000
            for i, row in enumerate(self.wait_rows):
                if i < MAX_WAIT_ROWS and i < len(waiting):
                    a = waiting[i]
                    what = t["wait_perm" if a["mode"] == "permission" else "wait_input"]
                    mins = f" · {max(0, int((now_ms - a['waitingSince']) / 60000))} min" if a["waitingSince"] else ""
                    row.set_label(f"⚠ {a['name']} — {what}{mins}")
                    row.show()
                elif i == MAX_WAIT_ROWS and len(waiting) > MAX_WAIT_ROWS:
                    row.set_label(t["more"].format(n=len(waiting) - MAX_WAIT_ROWS))
                    row.show()
                else:
                    row.hide()
        finally:
            self.updating = False
        if not on:
            self.ind.set_icon_full("image-missing", "Quiet Office: off")
        elif waiting:
            self.ind.set_icon_full("dialog-warning", "Quiet Office: an agent is waiting")
        elif until or manual:
            self.ind.set_icon_full("media-playback-pause", "Quiet Office: paused")
        else:
            self.ind.set_icon_full("image-x-generic", "Quiet Office")


# ── Selftest: load the demo, count page frames ───────────────────────────────

class Selftest:
    def __init__(self, host, seconds):
        self.host, self.seconds, self.started, self.result = host, seconds, False, None
        GLib.timeout_add_seconds(int(seconds) + 30, lambda: self.finish(0, "timeout") or False)

    def page_loaded(self, wall):
        if self.started:
            return
        self.started = True
        GLib.timeout_add(500, lambda: self.sample(wall, None) or False)

    def sample(self, wall, first):
        def got(value):
            n = int(value.to_double()) if value is not None and value.is_number() else 0
            if first is None:
                GLib.timeout_add(int(self.seconds * 1000), lambda: self.sample(wall, n) or False)
            else:
                self.finish(n - first, None, wall)
        wall.evaluate("typeof window.__quietOfficeFrames==='function'?window.__quietOfficeFrames():-1", got)

    def finish(self, frames, error, wall=None):
        if self.result is not None:
            return
        self.result = {"frames": max(0, frames), "url": wall.url if wall else None, "placement": self.host.placement,
                       "seconds": self.seconds, "monitors": len(self.host.walls)}
        if error:
            self.result["error"] = error
        if wall is None:
            print(json.dumps(self.result), flush=True)
            Gtk.main_quit()
            return
        wall.evaluate("typeof window.__wallpaper==='object'", self.report)

    def report(self, value):
        self.result["hook"] = bool(value is not None and value.is_boolean() and value.to_boolean())
        print(json.dumps(self.result), flush=True)
        Gtk.main_quit()


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_port(text):
    try:
        port = int(text)
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def main():
    parser = argparse.ArgumentParser(description="Quiet Office Linux host (experimental).",
                                     epilog="NVIDIA tip: blank or frozen window -> WEBKIT_DISABLE_DMABUF_RENDERER=1")
    parser.add_argument("port", nargs="?", help="server port (default QUIET_OFFICE_PORT or 47100)")
    parser.add_argument("--selftest", metavar="URL", help="load the demo from URL (http://127.0.0.1:<port>/), "
                        "count frames for 5 s, print JSON, exit 0 if frames > 0")
    parser.add_argument("--seconds", type=float, default=5.0, help=argparse.SUPPRESS)
    parser.add_argument("--log", action="store_true", help=f"append output to {LOG_DIR}/host.log")
    args = parser.parse_args()

    if args.log:
        os.makedirs(LOG_DIR, mode=0o700, exist_ok=True)
        path = os.path.join(LOG_DIR, "host.log")
        if os.path.exists(path) and os.path.getsize(path) > 5_000_000:
            os.replace(path, path + ".1")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.dup2(fd, 1)
        os.dup2(fd, 2)

    if args.selftest:
        u = urllib.parse.urlsplit(args.selftest)
        port = parse_port(u.port) if u.scheme == "http" and u.hostname == "127.0.0.1" else None
        if port is None:
            warn(f"--selftest needs http://127.0.0.1:<port>/, got '{args.selftest}'")
            return 2
    else:
        if args.port is not None and parse_port(args.port) is None:
            warn(f"ignoring argument '{args.port}': not a port number")
        if ENV.get("QUIET_OFFICE_PORT") and parse_port(ENV["QUIET_OFFICE_PORT"]) is None:
            warn(f"ignoring QUIET_OFFICE_PORT='{ENV['QUIET_OFFICE_PORT']}': not a port number")
        port = parse_port(args.port) or parse_port(ENV.get("QUIET_OFFICE_PORT")) or 47100
        # One copy at a time: autostart and a manual run can both start it.
        lock_dir = ENV.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
        lock_path = os.path.join(lock_dir, f"quiet-office-host-{os.getuid()}.lock")
        lock = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            warn(f"another host instance holds {lock_path}; exiting")
            return 0

    display = Gdk.Display.get_default()
    if display is None:
        warn("no display: set DISPLAY or WAYLAND_DISPLAY (CI: run under xvfb-run -a)")
        return 2
    placement = detect_placement(display)
    if placement in ("wayland-unsupported", "unknown"):
        if ENV.get("QUIET_OFFICE_FORCE") != "1":
            print(GNOME_MESSAGE, file=sys.stderr)
            return 3
        placement = "forced"
    if cairo is None:
        warn("pycairo missing (python3-gi-cairo): windows will take mouse input")

    host = Host(port, placement, Selftest(None, args.seconds) if args.selftest else None)
    if host.selftest:
        host.selftest.host = host
    log(f"start port={port} placement={placement} lang={host.lang} threshold={COVER_THRESHOLD} debug={DEBUG}"
        + (" dmabuf-renderer=off" if ENV.get("WEBKIT_DISABLE_DMABUF_RENDERER") else ""))
    host.watch_dbus()
    display.connect("monitor-added", host.monitors_changed)
    display.connect("monitor-removed", host.monitors_changed)
    display.get_default_screen().connect("monitors-changed", host.monitors_changed)

    if not host.selftest:
        indicator = optional("AyatanaAppIndicator3", "0.1") or optional("AppIndicator3", "0.1")
        if indicator is None:
            log("no AppIndicator library: no tray menu (SIGUSR1 pause, SIGUSR2 reload still work)")
        else:
            host.tray = Tray(host, indicator)
        GLib.timeout_add_seconds(STATE_S, lambda: host.fetch_state() or True)
        host.fetch_state()

    def usr1():
        host.reasons ^= {"manual"}
        host.check()
        host.refresh_ui()
        return True

    def usr2():
        host.state = load_state()
        host.config = read_config()
        host.apply_enabled()
        host.sync_options()
        host.reload()
        return True
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, usr1)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2, usr2)
    for sig in (signal.SIGINT, signal.SIGTERM):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, lambda: Gtk.main_quit() or False)

    if host.state["enabled"] or host.selftest:
        host.start()
    else:
        log("disabled (saved); no windows")
    Gtk.main()
    host.stop()
    if host.selftest:
        return 0 if (host.selftest.result or {}).get("frames", 0) > 0 else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

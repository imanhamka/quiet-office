// Quiet Office: desktop-level WKWebView host (macOS).
// One borderless window per screen, behind the desktop icons, on every Space. Each window shows
// http://127.0.0.1:<port>/?wallpaper=1&screen=<index>&inset=<t,r,b,l>&lang=<en|ms> and tells the
// page to pause or resume.
//
// Window setup, WebKit private-selector setup and the Stage Manager fit() logic are adapted from
// Agent City (AgentCity.swift, MIT License). Its desktop-picture snapshot feature and its node
// server spawner are removed: this host never changes the desktop picture and starts no server.
//
// Env: QUIET_OFFICE_PORT (default 47100, a first CLI argument wins), QUIET_OFFICE_DEBUG=1 (coverage
// log every check, menu dump, page messages from the `wp` handler), QUIET_OFFICE_COVER_THRESHOLD
// (testing only), XDG_CONFIG_HOME (config.json location).
// Menu bar item (always on, EN/MS): wallpaper on/off (saved, survives login), pause timers,
// read-only agent summary and waiting list from GET /state, reload, restart server, open logs.
// Saved state: `defaults read io.github.imanhamka.quiet-office` (enabled, pausedUntil, privacy,
// privacyAuto, daypart (auto|day|night), notifyWaiting, lang (en|ms; unset = auto)).
// Config (read only, never written): ${XDG_CONFIG_HOME:-~/.config}/quiet-office/config.json keys
// lang, privacy.default, privacy.autoProcesses. Missing or invalid = defaults.
// Signals: SIGUSR1 toggles a manual pause on all screens, SIGUSR2 re-reads saved state and reloads.
// The page may only load http://127.0.0.1:<port>/ (and about:blank); window.open is refused.
import Cocoa
import UserNotifications
import WebKit

setvbuf(stdout, nil, _IOLBF, 0)

let env = ProcessInfo.processInfo.environment
let debug = env["QUIET_OFFICE_DEBUG"] == "1"
// QUIET_OFFICE_COVER_THRESHOLD (0..1, default 0.90) exists for testing; a value above 1 never pauses on coverage.
let coverThreshold = env["QUIET_OFFICE_COVER_THRESHOLD"].flatMap(Double.init) ?? 0.90
let resumeFPS = 12
let retryInterval: TimeInterval = 5
let checkInterval: TimeInterval = 2
let background = NSColor(srgbRed: 0x14 / 255.0, green: 0x12 / 255.0, blue: 0x16 / 255.0, alpha: 1)

let stamp: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.timeZone = .current
    return f
}()
func log(_ line: String) { print("\(stamp.string(from: Date())) \(line)") }
func warn(_ line: String) { FileHandle.standardError.write(Data("quiet-office: \(line)\n".utf8)) }

let port: Int = {
    func parse(_ s: String?) -> Int? { s.flatMap(Int.init).flatMap { (1...65535).contains($0) ? $0 : nil } }
    let arg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil
    if let arg, parse(arg) == nil { warn("ignoring argument '\(arg)': not a port number") }
    if let s = env["QUIET_OFFICE_PORT"], parse(s) == nil { warn("ignoring QUIET_OFFICE_PORT='\(s)': not a port number") }
    return parse(arg) ?? parse(env["QUIET_OFFICE_PORT"]) ?? 47100
}()

// A borderless window that keeps exactly the frame it is given (no tiling margins,
// never becomes key), so the wallpaper always covers the whole screen.
final class DesktopWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// WKUserContentController retains its handlers; this proxy keeps that from retaining the Wallpaper.
final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: Wallpaper?
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let owner else { return }
        log("debug screen=\(owner.index) page \(message.body)")
    }
}

var warnedSelectors = Set<String>()
func disable(_ name: String, on object: NSObject) {
    let sel = NSSelectorFromString(name)
    if object.responds(to: sel) {
        object.perform(sel, with: nil)              // nil for a BOOL argument means NO
    } else if warnedSelectors.insert(name).inserted {
        warn("WebKit private selector \(name) missing; page may freeze")
    }
}

// One in-memory store for every screen: nothing reaches disk, and a host restart starts clean.
let dataStore = WKWebsiteDataStore.nonPersistent()

// The only page the web views may show. Every other navigation is refused.
func isAllowedPage(_ url: URL?) -> Bool {
    guard let url else { return false }
    if url.absoluteString == "about:blank" { return true }
    return url.scheme?.lowercased() == "http" && url.host == "127.0.0.1" && (url.port ?? 80) == port
        && url.user == nil && url.password == nil
}

final class Wallpaper: NSObject, WKNavigationDelegate, WKUIDelegate {
    let index: Int
    let displayID: CGDirectDisplayID?
    let window: DesktopWindow
    let web: WKWebView
    private let query: String                        // screen + insets at window creation
    var url: URL { URL(string: "http://127.0.0.1:\(port)/?wallpaper=1&\(query)&lang=\(currentLang.rawValue)")! }
    private let proxy = MessageProxy()
    private var retryTimer: Timer?
    private var fitTimer: Timer?
    private var target = NSRect.zero
    private var extra = CGSize.zero
    private var loaded = false
    private var failing = false
    private var sentPaused: Bool?                    // what the page was last told; nil after each load
    private var sending = false
    private var wantPaused = false
    private var wantReason = ""
    private var sentInsets: String?                  // insets the page last got; nil after each load
    private var closed = false
    private var sentOptions: String?                 // options the page last got; nil after each load

    // Safe-area insets in points as "top,right,bottom,left": menu bar and Dock excluded.
    static func insets(of screen: NSScreen) -> String {
        let f = screen.frame, v = screen.visibleFrame
        let parts = [f.maxY - v.maxY, f.maxX - v.maxX, v.minY - f.minY, v.minX - f.minX]
        return parts.map { String(Int($0.rounded())) }.joined(separator: ",")
    }

    // Tells the page about a Dock / menu bar change without reloading it.
    func updateInsets() {
        guard loaded, let id = displayID,
              let screen = NSScreen.screens.first(where: {
                  ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
              }) else { return }
        let now = Wallpaper.insets(of: screen)
        guard now != sentInsets else { return }
        let js = "(function(){var w=window.__wallpaper;if(!w||!w.setInsets)return false;w.setInsets(\(now));return true})()"
        web.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self, (result as? Bool) == true else { return }
            if self.sentInsets != nil { log("screen=\(self.index) insets=\(now)") }
            self.sentInsets = now
        }
    }

    init(screen: NSScreen, index: Int) {
        self.index = index
        displayID = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        query = "screen=\(index)&inset=\(Wallpaper.insets(of: screen))"
        let frame = screen.frame
        window = DesktopWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.setFrame(frame, display: false)
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        window.ignoresMouseEvents = true
        window.isReleasedWhenClosed = false
        window.hasShadow = false
        window.backgroundColor = background

        // macOS treats desktop-level windows as covered by the desktop-icon layer, so WebKit
        // would freeze the page (no rAF, 1/s timers). Turn off occlusion and hidden-page throttling.
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        disable("_setPageVisibilityBasedProcessSuppressionEnabled:", on: config.preferences)
        disable("_setHiddenPageDOMTimerThrottlingEnabled:", on: config.preferences)
        if debug { config.userContentController.add(proxy, name: "wp") }
        web = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        disable("_setWindowOcclusionDetectionEnabled:", on: web)
        web.autoresizingMask = [.width, .height]
        web.underPageBackgroundColor = background
        web.alphaValue = 0                           // window stays dark until the page has painted
        super.init()
        proxy.owner = self
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
        window.orderFront(nil)
        window.setFrame(frame, display: true)
        target = frame
        load()
        fit()
        fitTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.fit() }
    }

    // Global display coordinates, top-left origin: the same space as CGWindowList bounds.
    var displayBounds: CGRect {
        if let displayID { return CGDisplayBounds(displayID) }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return CGRect(x: target.minX, y: primaryHeight - target.maxY, width: target.width, height: target.height)
    }

    // Stage Manager shrinks windows it manages by a fixed margin, even at desktop level.
    // Measure what the window server actually shows and oversize the window to cancel it.
    private func serverBounds() -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(window.windowNumber)) as? [[String: Any]],
              let b = list.first?[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    }

    private func fit(attempt: Int = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, let b = self.serverBounds() else { return }
            let missW = self.target.width - b.width, missH = self.target.height - b.height
            guard abs(missW) > 0.5 || abs(missH) > 0.5 else { return }
            self.extra.width += missW
            self.extra.height += missH
            self.window.setFrame(self.target.insetBy(dx: -self.extra.width / 2, dy: -self.extra.height / 2), display: true)
            if attempt < 4 { self.fit(attempt: attempt + 1) }
        }
    }

    func load() {
        retryTimer?.invalidate()
        retryTimer = nil
        loaded = false
        sentPaused = nil
        // Drop cached sub-resources (layout JSON, sprites) so a rebuild shows on reload.
        let types: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
        dataStore.removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
            guard let self, !self.closed else { return }
            self.web.load(URLRequest(url: self.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
        }
    }

    private func failed(_ what: String) {
        loaded = false
        web.alphaValue = 0
        if !failing {
            log("screen=\(index) load failed (\(what)); retrying every \(Int(retryInterval))s")
            failing = true
        }
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: retryInterval, repeats: false) { [weak self] _ in self?.load() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let target = navigationAction.request.url
        if isAllowedPage(target) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            log("screen=\(index) refused navigation to \(target?.scheme ?? "?")://\(target?.host ?? "?")")
        }
    }

    // No window.open, no target=_blank: the page never gets a second web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        log("screen=\(index) refused new window to \(navigationAction.request.url?.host ?? "?")")
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {     // never download
            decisionHandler(.cancel)
            return
        }
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, http.statusCode >= 400 {
            decisionHandler(.cancel)
            failed("HTTP \(http.statusCode)")
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Our own .cancel above lands here as "frame load interrupted"; failed() already ran.
        if (error as NSError).domain == "WebKitErrorDomain", (error as NSError).code == 102 { return }
        failed(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("screen=\(index) WebContent process terminated; reloading")
        loaded = false
        web.alphaValue = 0
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in self?.load() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("screen=\(index) loaded \(url.absoluteString)")
        failing = false
        loaded = true
        sentPaused = nil                             // a fresh page has its own default state
        sentInsets = nil
        sentOptions = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, self.loaded else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.8
                self.web.animator().alphaValue = 1
            }
        }
        apply(paused: wantPaused, reason: wantReason)
        updateInsets()
        updateOptions()
    }

    /// Sends `pageOptions` (built from enums and booleans only) when it changed or after a load.
    func updateOptions() {
        guard loaded else { return }
        let now = pageOptions
        guard now != sentOptions else { return }
        let js = "(function(){var w=window.__wallpaper;if(!w||!w.setOptions)return false;w.setOptions(\(now));return true})()"
        web.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self, (result as? Bool) == true else { return }
            log("screen=\(self.index) options=\(now)")
            self.sentOptions = now
        }
    }

    // Tells the page the wanted state when it differs from what it was last told.
    // If window.__wallpaper is not defined yet, the next check tries again.
    func apply(paused: Bool, reason: String) {
        wantPaused = paused
        wantReason = reason
        guard loaded, !sending, sentPaused != paused else { return }
        let call = paused ? "pause()" : "resume(\(resumeFPS))"
        let js = "(function(){var w=window.__wallpaper;if(!w)return false;w.\(call);return true})()"
        sending = true
        web.evaluateJavaScript(js) { [weak self] result, error in
            guard let self else { return }
            self.sending = false
            if (result as? Bool) == true {
                self.sentPaused = paused
                log("screen=\(self.index) \(paused ? "pause" : "resume") reason=\(reason)")
            } else if debug {
                log("debug screen=\(self.index) window.__wallpaper not ready\(error.map { " (\($0.localizedDescription))" } ?? "")")
            }
            if self.sentPaused != nil, self.wantPaused != self.sentPaused {
                self.apply(paused: self.wantPaused, reason: self.wantReason)
            }
        }
    }

    deinit { log("screen=\(index) released") }

    func close() {
        closed = true
        fitTimer?.invalidate()
        retryTimer?.invalidate()
        // Unload the page first: the web view can outlive its closed window.
        web.navigationDelegate = nil
        web.uiDelegate = nil
        web.configuration.userContentController.removeAllScriptMessageHandlers()
        web.stopLoading()
        web.loadHTMLString("", baseURL: nil)
        window.orderOut(nil)
        window.close()
    }
}

// Normal app windows (layer 0) of other processes, in global top-left coordinates.
// Bounds and owner need no Screen Recording permission; only kCGWindowName does.
struct AppWindow { let rect: CGRect; let owner: String }

func appWindows() -> [AppWindow] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    let me = ProcessInfo.processInfo.processIdentifier
    return list.compactMap { w in
        guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              ((w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
              (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value != me,
              let b = w[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: b), rect.width > 0, rect.height > 0 else { return nil }
        return AppWindow(rect: rect, owner: w[kCGWindowOwnerName as String] as? String ?? "?")
    }
}

// Covered fraction of `screen`, counting overlaps once: a 64x36 grid cell counts as covered
// when its centre lies inside any window.
func coverage(of screen: CGRect, by rects: [CGRect]) -> Double {
    let cols = 64, rows = 36
    guard screen.width > 0, screen.height > 0 else { return 0 }
    var grid = [Bool](repeating: false, count: cols * rows)
    let cw = screen.width / CGFloat(cols), ch = screen.height / CGFloat(rows)
    for r in rects {
        let i = r.intersection(screen)
        guard !i.isNull, !i.isEmpty else { continue }
        let c0 = max(0, Int(((i.minX - screen.minX) / cw - 0.5).rounded(.up)))
        let c1 = min(cols - 1, Int(((i.maxX - screen.minX) / cw - 0.5).rounded(.up)) - 1)
        let r0 = max(0, Int(((i.minY - screen.minY) / ch - 0.5).rounded(.up)))
        let r1 = min(rows - 1, Int(((i.maxY - screen.minY) / ch - 0.5).rounded(.up)) - 1)
        guard c0 <= c1, r0 <= r1 else { continue }
        for row in r0...r1 { for col in c0...c1 { grid[row * cols + col] = true } }
    }
    return Double(grid.lazy.filter { $0 }.count) / Double(cols * rows)
}

func sessionIsLocked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var walls: [Wallpaper] = []
    var reasons = Set<String>()                      // pause reasons that apply to every screen
    var lockedAt = Date.distantPast
    var checkTimer: Timer?
    var statusItem: NSStatusItem?
    var signalSources: [DispatchSourceSignal] = []
    var running = false                              // windows built and the check timer on
    var stateTimer: Timer?
    var agents: [AgentInfo] = []                     // last GET /state (name + mode only)
    var serverUp = false
    var fetching = false
    let menu = NSMenu()
    var toggleItem = NSMenuItem()
    var pauseItem = NSMenuItem()
    var resumeNowItem = NSMenuItem()
    var summaryItem = NSMenuItem()
    var waitRows: [NSMenuItem] = []
    var reloadItem = NSMenuItem()
    var menuIsOpen = false
    var today: (sessions: Int, subtasks: Int)?
    var notified = Set<String>()                     // "name|waitingSince" already notified
    var privacyItem = NSMenuItem()
    var privacyAutoItem = NSMenuItem()
    var notifyItem = NSMenuItem()
    var todayItem = NSMenuItem()
    var daypartItems: [NSMenuItem] = []
    var langItems: [NSMenuItem] = []
    var langConfigItem = NSMenuItem()
    var quitItem = NSMenuItem()
    var titled: [(item: NSMenuItem, key: String)] = []   // fixed titles, re-set on a language change
    var config = HostConfig()
    var configSeen: String?
    var sharingWith: String?                         // the auto-privacy process that is running

    func applicationDidFinishLaunching(_ notification: Notification) {
        log("start port=\(port) screens=\(NSScreen.screens.count) threshold=\(coverThreshold) debug=\(debug)")
        if debug { reportPermissions() }
        configSeen = configStamp()
        config = readConfig()
        currentLang = resolveLang(config)
        log("config \(configSeen == nil ? "none" : configURL.path) lang=\(currentLang.rawValue) autoProcesses=\(config.autoProcesses.count)")
        pageOptions = buildOptions()
        if isEnabled { start() } else { log("disabled (saved); no windows") }

        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        let dnc = DistributedNotificationCenter.default()
        let ws = NSWorkspace.shared.notificationCenter
        let toggles: [(NotificationCenter, String, String, Bool)] = [
            (dnc, "com.apple.screenIsLocked", "locked", true),
            (dnc, "com.apple.screenIsUnlocked", "locked", false),
            (dnc, "com.apple.screensaver.didstart", "screensaver", true),
            (dnc, "com.apple.screensaver.didstop", "screensaver", false),
            (ws, NSWorkspace.screensDidSleepNotification.rawValue, "display-sleep", true),
            (ws, NSWorkspace.screensDidWakeNotification.rawValue, "display-sleep", false),
            (ws, NSWorkspace.willSleepNotification.rawValue, "system-sleep", true),
            (ws, NSWorkspace.didWakeNotification.rawValue, "system-sleep", false),
        ]
        for (center, name, reason, on) in toggles {
            center.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                if on { self.reasons.insert(reason) } else { self.reasons.remove(reason) }
                if reason == "locked" && on { self.lockedAt = Date() }
                if debug { log("debug event \(name)") }
                self.check()
            }
        }
        // Coverage can change at once on these; the timer catches window moves and resizes.
        for name in [NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didActivateApplicationNotification,
                     NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification,
                     NSWorkspace.didTerminateApplicationNotification] {
            ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.check() }
            }
        }

        onSignal(SIGUSR1) { [weak self] in
            guard let self else { return }
            if self.reasons.remove("manual") == nil { self.reasons.insert("manual") }
            self.check()
            self.updateIcon()
        }
        onSignal(SIGUSR2) { [weak self] in
            guard let self else { return }
            self.configSeen = nil                    // force a config re-read
            self.reloadConfigIfChanged()
            self.applyEnabled()
            self.syncOptions()
            self.reload()
        }

        addStatusItem()
        stateTimer = Timer.scheduledTimer(withTimeInterval: stateInterval, repeats: true) { [weak self] _ in self?.fetchState() }
        stateTimer?.tolerance = 2
        fetchState()
        check()
    }

    func onSignal(_ sig: Int32, _ handler: @escaping () -> Void) {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler(handler: handler)
        src.resume()
        signalSources.append(src)
    }

    func reportPermissions() {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let withBounds = list.filter { $0[kCGWindowBounds as String] != nil }.count
        let withName = list.filter { $0[kCGWindowName as String] != nil }.count
        log("debug permission screenRecording=\(CGPreflightScreenCaptureAccess()) windows=\(list.count) withBounds=\(withBounds) withName=\(withName)")
        for w in appWindows() {
            log("debug window owner=\(w.owner) bounds=\(Int(w.rect.minX)),\(Int(w.rect.minY)) \(Int(w.rect.width))x\(Int(w.rect.height))")
        }
    }

    func buildWindows() {
        walls.forEach { $0.close() }
        walls = NSScreen.screens.enumerated().map { Wallpaper(screen: $0.element, index: $0.offset) }
    }

    @objc func screensChanged() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            guard self.running else { return }
            log("screens changed; rebuilding \(NSScreen.screens.count) window(s)")
            self.buildWindows()
            self.check()
        }
    }

    func check() {
        // The session dictionary repairs a missed lock/unlock notification. The 10 s grace keeps a
        // lagging dictionary from undoing a fresh lock notification.
        if sessionIsLocked() {
            reasons.insert("locked")
        } else if reasons.contains("locked"), Date().timeIntervalSince(lockedAt) > 10 {
            reasons.remove("locked")
        }
        if let until = pausedUntil, until > Date() {
            reasons.insert("timed")
        } else {
            if pausedUntil != nil { pausedUntil = nil; log("timed pause over") }
            reasons.remove("timed")
        }
        reloadConfigIfChanged()
        let match = privacyAuto ? runningAutoProcess() : nil
        if match != sharingWith {
            sharingWith = match
            log(match != nil ? "auto-privacy process running: privacy on" : "auto-privacy process gone")
            syncOptions()
        }
        let windows = appWindows()
        for wall in walls {
            let screen = wall.displayBounds
            let onScreen = windows.filter { $0.rect.intersects(screen) }
            let covered = coverage(of: screen, by: onScreen.map(\.rect))
            let pct = String(format: "%.1f%%", covered * 100)
            var why = reasons
            if let id = wall.displayID, CGDisplayIsAsleep(id) != 0 { why.insert("display-asleep") }
            if covered >= coverThreshold { why.insert("covered") }
            if debug { log("debug screen=\(wall.index) coverage=\(pct) windows=\(onScreen.count) reasons=\(why.sorted())") }
            let paused = !why.isEmpty
            wall.updateInsets()
            wall.updateOptions()
            wall.apply(paused: paused, reason: (paused ? why.sorted().joined(separator: ",") : "visible") + " coverage=\(pct)")
        }
    }

    @objc func reload() {
        log("reload all")
        walls.forEach { $0.load() }
    }
    @objc func quit() { NSApp.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        walls.forEach { $0.close() }
    }
}

// MARK: - Config file and language

let prefs = UserDefaults.standard

enum Lang: String { case en, ms }

/// The keys of config.json this host uses. The server reads the same file for its own keys.
struct HostConfig: Equatable {
    static let defaultProcesses = ["CptHost"]
    var lang: Lang?                                  // nil = auto
    var privacyDefault = false
    var autoProcesses = HostConfig.defaultProcesses
}

let configURL: URL = {
    let xdg = env["XDG_CONFIG_HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil }
    let base = xdg.map { URL(fileURLWithPath: $0) }
        ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config")
    return base.appendingPathComponent("quiet-office/config.json")
}()
let maxConfigBytes = 64 * 1024
let maxAutoProcesses = 16
let maxProcessName = 32                              // proc_name() never returns a longer name

/// Missing file = defaults. Unreadable or invalid JSON = defaults. A key with a wrong type or
/// value is ignored and keeps its default.
func readConfig() -> HostConfig {
    var c = HostConfig()
    let attrs = try? FileManager.default.attributesOfItem(atPath: configURL.path)
    guard let size = (attrs?[.size] as? NSNumber)?.intValue else { return c }
    guard size <= maxConfigBytes else {
        warn("ignoring \(configURL.path): larger than \(maxConfigBytes) bytes")
        return c
    }
    guard let data = try? Data(contentsOf: configURL),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        warn("ignoring \(configURL.path): not a JSON object")
        return c
    }
    if let raw = root["lang"] as? String { c.lang = Lang(rawValue: raw) }
    if let privacy = root["privacy"] as? [String: Any] {
        if let d = privacy["default"] as? Bool { c.privacyDefault = d }
        if let list = privacy["autoProcesses"] as? [Any] {
            let names = list.compactMap { $0 as? String }
                .filter { !$0.isEmpty && $0.utf8.count <= maxProcessName }
            c.autoProcesses = Array(names.prefix(maxAutoProcesses))
        }
    }
    return c
}

/// Size and mtime of config.json at the last read; nil = no file.
func configStamp() -> String? {
    guard let a = try? FileManager.default.attributesOfItem(atPath: configURL.path) else { return nil }
    return "\((a[.size] as? NSNumber)?.intValue ?? -1)@\((a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
}

var currentLang: Lang = .en

/// config.json `lang` (en|ms) wins, then the menu choice saved in defaults `lang`, then the
/// first system language (ms* = Malay, anything else = English).
func resolveLang(_ config: HostConfig) -> Lang {
    if let c = config.lang { return c }
    if let saved = prefs.string(forKey: "lang").flatMap(Lang.init(rawValue:)) { return saved }
    return Locale.preferredLanguages.first?.lowercased().hasPrefix("ms") == true ? .ms : .en
}

let strings: [Lang: [String: String]] = [
    .en: [
        "app": "Quiet Office",
        "icon.off": "Quiet Office: off",
        "icon.waiting": "Quiet Office: agent waiting",
        "icon.paused": "Quiet Office: paused",
        "wallpaperOn": "Wallpaper On",
        "pause": "Pause",
        "pause.15": "15 minutes",
        "pause.60": "1 hour",
        "pause.morning": "Until tomorrow morning (7:00)",
        "pause.resume": "Resume now",
        "pause.until": "Paused until %@",
        "pause.manual": "Paused (manual)",
        "agents": "AGENTS",
        "server.down": "Server unreachable",
        "sum.active": "%d active",
        "sum.idle": "%d idle",
        "sum.waiting": "%d waiting",
        "sum.sub": "%d sub",
        "wait.permission": "waiting for permission",
        "wait.input": "waiting for input",
        "wait.more": "and %d more",
        "today": "Today: %d sessions · %d subtasks",
        "today.none": "Today: —",
        "privacy": "Privacy Mode",
        "privacy.auto.zoom": "Auto during screen share (Zoom)",
        "privacy.auto.custom": "Auto while a listed app runs",
        "privacy.active.zoom": "Active now: Zoom is sharing the screen",
        "privacy.active.custom": "Active now: %@ is running",
        "daypart": "Day / Night",
        "daypart.auto": "Follow the clock",
        "daypart.day": "Day",
        "daypart.night": "Night",
        "notify": "Notify when an agent waits > 2 min",
        "language": "Language",
        "lang.auto": "Auto (system)",
        "lang.config": "Set in config.json",
        "reload": "Reload",
        "advanced": "Advanced",
        "restartServer": "Restart Server",
        "openLogs": "Open Logs Folder",
        "quit": "Quit",
        "quit.sub": "The icon stays gone until the next login",
    ],
    .ms: [
        "app": "Quiet Office",
        "icon.off": "Quiet Office: dimatikan",
        "icon.waiting": "Quiet Office: ejen menunggu",
        "icon.paused": "Quiet Office: dijeda",
        "wallpaperOn": "Wallpaper Hidup",
        "pause": "Jeda",
        "pause.15": "15 minit",
        "pause.60": "1 jam",
        "pause.morning": "Hingga esok pagi (7:00)",
        "pause.resume": "Sambung sekarang",
        "pause.until": "Dijeda hingga %@",
        "pause.manual": "Dijeda (manual)",
        "agents": "EJEN",
        "server.down": "Pelayan tidak dapat dihubungi",
        "sum.active": "%d aktif",
        "sum.idle": "%d rehat",
        "sum.waiting": "%d menunggu",
        "sum.sub": "%d sub",
        "wait.permission": "menunggu kebenaran",
        "wait.input": "menunggu arahan",
        "wait.more": "dan %d lagi",
        "today": "Hari ini: %d sesi · %d subtugas",
        "today.none": "Hari ini: —",
        "privacy": "Mod Privasi",
        "privacy.auto.zoom": "Auto semasa kongsi skrin (Zoom)",
        "privacy.auto.custom": "Auto semasa aplikasi tersenarai berjalan",
        "privacy.active.zoom": "Sedang aktif: Zoom berkongsi skrin",
        "privacy.active.custom": "Sedang aktif: %@ sedang berjalan",
        "daypart": "Siang / Malam",
        "daypart.auto": "Ikut jam",
        "daypart.day": "Siang",
        "daypart.night": "Malam",
        "notify": "Beritahu bila ejen menunggu > 2 min",
        "language": "Bahasa",
        "lang.auto": "Auto (sistem)",
        "lang.config": "Ditetapkan dalam config.json",
        "reload": "Muat Semula",
        "advanced": "Lanjutan",
        "restartServer": "Mulakan Semula Pelayan",
        "openLogs": "Buka Folder Log",
        "quit": "Keluar",
        "quit.sub": "Ikon hilang hingga log masuk semula",
    ],
]

func t(_ key: String, _ args: CVarArg...) -> String {
    let format = strings[currentLang]?[key] ?? strings[.en]?[key] ?? key
    return args.isEmpty ? format : String(format: format, arguments: args)
}

// MARK: - Menu bar control
//
// Read-only toward Claude sessions: the menu shows agent names and a state from GET /state
// and nothing else (no cwd, no tool text). It sends nothing to sessions and the server stays
// GET-only. The only external command is a fixed `launchctl kickstart` of the server agent.

let stateInterval: TimeInterval = 10
let maxWaitRows = 5
let serverLabel = "io.github.imanhamka.quiet-office.server"
let logDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/quiet-office")
// Ephemeral: no cookie jar or URL cache on disk.
let stateSession = URLSession(configuration: .ephemeral)

struct AgentInfo {
    enum Mode: String { case active, idle, permission, input }
    let name: String
    let mode: Mode
    let waitingSince: Date?
    let subagents: Int
}

extension AppDelegate: NSMenuDelegate {
    var isEnabled: Bool { prefs.object(forKey: "enabled") as? Bool ?? true }

    /// When a timed pause ends; persisted so it survives a restart of the host.
    var pausedUntil: Date? {
        get {
            let t = prefs.double(forKey: "pausedUntil")
            return t > 0 ? Date(timeIntervalSince1970: t) : nil
        }
        set {
            if let d = newValue { prefs.set(d.timeIntervalSince1970, forKey: "pausedUntil") } else { prefs.removeObject(forKey: "pausedUntil") }
        }
    }

    func start() {
        guard !running else { return }
        log("wallpaper on")
        running = true
        buildWindows()
        checkTimer = Timer.scheduledTimer(withTimeInterval: checkInterval, repeats: true) { [weak self] _ in self?.check() }
        checkTimer?.tolerance = 0.3
        check()
    }

    /// Off: every window and its WebKit processes go away; the system wallpaper shows again.
    func stop() {
        guard running else { return }
        log("wallpaper off: closing \(walls.count) window(s)")
        running = false
        checkTimer?.invalidate()
        checkTimer = nil
        walls.forEach { $0.close() }
        walls = []
    }

    /// Makes the running state match the saved `enabled` (the menu, or `defaults write` + SIGUSR2).
    func applyEnabled() {
        if isEnabled { start() } else { stop() }
        updateIcon()
    }

    @objc func toggleEnabled() {
        prefs.set(!isEnabled, forKey: "enabled")
        log(isEnabled ? "enabled from menu" : "disabled from menu")
        applyEnabled()
    }

    @objc func pauseFor(_ sender: NSMenuItem) {
        let now = Date()
        let until: Date
        if sender.tag == 0 {
            // Tomorrow 07:00 local time.
            let cal = Calendar.current
            let tomorrow = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) ?? now
            until = cal.date(bySettingHour: 7, minute: 0, second: 0, of: tomorrow) ?? now.addingTimeInterval(12 * 3600)
        } else {
            until = now.addingTimeInterval(TimeInterval(sender.tag) * 60)
        }
        pausedUntil = until
        log("timed pause until \(stamp.string(from: until))")
        check()
        updateIcon()
    }

    @objc func resumeNow() {
        pausedUntil = nil
        reasons.remove("timed")
        reasons.remove("manual")
        log("resumed from menu")
        check()
        updateIcon()
    }

    @objc func restartServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "-k", "gui/\(getuid())/\(serverLabel)"]
        p.terminationHandler = { proc in
            DispatchQueue.main.async {
                log("server restart exit=\(proc.terminationStatus)")
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.fetchState() }
            }
        }
        do { try p.run() } catch { log("server restart failed: \(error.localizedDescription)") }
    }

    @objc func openLogs() {
        NSWorkspace.shared.open(logDir)
    }

    // MARK: Agent data (GET /state, whitelisted fields)

    func fetchState() {
        guard !fetching, let url = URL(string: "http://127.0.0.1:\(port)/state") else { return }
        fetching = true
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        req.httpMethod = "GET"
        stateSession.dataTask(with: req) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let parsed = ok ? data.flatMap(AppDelegate.parseAgents) : nil
            let today = ok ? data.flatMap(AppDelegate.parseToday) : nil
            DispatchQueue.main.async {
                self.fetching = false
                self.serverUp = parsed != nil
                self.agents = parsed ?? []
                self.today = today
                self.notifyLongWaits()
                self.updateIcon()
                if self.menuIsOpen { self.refreshTitles() }
                if debug { self.refreshTitles(); self.dumpMenu(self.menu, depth: 0) }
            }
        }.resume()
    }

    static func parseAgents(_ data: Data) -> [AgentInfo]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["agents"] as? [[String: Any]] else { return nil }
        return list.compactMap { a in
            guard let name = a["name"] as? String, let raw = a["mode"] as? String,
                  let mode = AgentInfo.Mode(rawValue: raw) else { return nil }
            let since = (a["waitingSince"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
            let subs = (a["subagents"] as? [Any])?.count ?? 0
            return AgentInfo(name: String(name.prefix(40)), mode: mode, waitingSince: since, subagents: subs)
        }
    }

    static func parseToday(_ data: Data) -> (sessions: Int, subtasks: Int)? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = root["today"] as? [String: Any],
              let sessions = (t["sessions"] as? NSNumber)?.intValue,
              let subtasks = (t["subtasks"] as? NSNumber)?.intValue else { return nil }
        return (max(0, sessions), max(0, subtasks))
    }

    var waiting: [AgentInfo] {
        agents.filter { $0.mode == .permission || $0.mode == .input }
            .sorted { ($0.waitingSince ?? .distantFuture) < ($1.waitingSince ?? .distantFuture) }
    }

    // MARK: Icon

    func symbol(_ names: [String], _ label: String) -> NSImage? {
        for n in names {
            if let img = NSImage(systemSymbolName: n, accessibilityDescription: label) {
                img.isTemplate = true
                return img
            }
        }
        return nil
    }

    func updateIcon() {
        guard let button = statusItem?.button else { return }
        let manualPause = pausedUntil != nil || reasons.contains("manual")
        if !isEnabled {
            button.image = symbol(["photo.on.rectangle"], t("icon.off"))
            button.appearsDisabled = true
        } else if !waiting.isEmpty {
            button.image = symbol(["photo.badge.exclamationmark", "exclamationmark.triangle"], t("icon.waiting"))
            button.appearsDisabled = false
        } else if manualPause {
            button.image = symbol(["pause.rectangle", "photo.on.rectangle"], t("icon.paused"))
            button.appearsDisabled = false
        } else {
            button.image = symbol(["photo.on.rectangle"], t("app"))
            button.appearsDisabled = false
        }
    }

    // MARK: Menu

    /// A menu item whose title comes from the string table and follows language changes.
    func item(_ key: String, _ action: Selector?, _ keyEquivalent: String = "") -> NSMenuItem {
        let it = NSMenuItem(title: t(key), action: action, keyEquivalent: keyEquivalent)
        if action != nil { it.target = self }
        titled.append((it, key))
        return it
    }

    func addStatusItem() {
        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.autosaveName = "quiet-office.status"
        statusItem = status

        toggleItem = item("wallpaperOn", #selector(toggleEnabled))
        menu.addItem(toggleItem)

        let pauseMenu = NSMenu()
        for (key, tag) in [("pause.15", 15), ("pause.60", 60), ("pause.morning", 0)] {
            let it = item(key, #selector(pauseFor(_:)))
            it.tag = tag
            pauseMenu.addItem(it)
        }
        pauseMenu.addItem(.separator())
        resumeNowItem = item("pause.resume", #selector(resumeNow))
        pauseMenu.addItem(resumeNowItem)
        pauseItem = NSMenuItem(title: t("pause"), action: nil, keyEquivalent: "")
        pauseItem.submenu = pauseMenu
        menu.addItem(pauseItem)

        menu.addItem(.separator())
        let header: NSMenuItem
        if #available(macOS 14.0, *) {
            header = NSMenuItem.sectionHeader(title: t("agents"))
        } else {
            header = NSMenuItem(title: t("agents"), action: nil, keyEquivalent: "")
            header.isEnabled = false
        }
        titled.append((header, "agents"))
        menu.addItem(header)
        summaryItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        summaryItem.isEnabled = false
        menu.addItem(summaryItem)
        waitRows = (0...maxWaitRows).map { _ in
            let it = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            it.isEnabled = false
            return it
        }
        waitRows.forEach { menu.addItem($0) }
        todayItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        todayItem.isEnabled = false
        menu.addItem(todayItem)

        menu.addItem(.separator())
        privacyItem = item("privacy", #selector(togglePrivacy))
        menu.addItem(privacyItem)
        privacyAutoItem = NSMenuItem(title: "", action: #selector(togglePrivacyAuto), keyEquivalent: "")
        privacyAutoItem.target = self
        privacyAutoItem.indentationLevel = 1
        menu.addItem(privacyAutoItem)
        let dayMenu = NSMenu()
        for (key, mode) in [("daypart.auto", "auto"), ("daypart.day", "day"), ("daypart.night", "night")] {
            let it = item(key, #selector(setDaypart(_:)))
            it.representedObject = mode
            dayMenu.addItem(it)
            daypartItems.append(it)
        }
        let dayItem = item("daypart", nil)
        dayItem.submenu = dayMenu
        menu.addItem(dayItem)
        notifyItem = item("notify", #selector(toggleNotify))
        menu.addItem(notifyItem)
        let langMenu = NSMenu()
        langMenu.autoenablesItems = false
        // Language names stay in their own language.
        for (title, code) in [(t("lang.auto"), "auto"), ("English", "en"), ("Bahasa Melayu", "ms")] {
            let it = NSMenuItem(title: title, action: #selector(setLanguage(_:)), keyEquivalent: "")
            it.representedObject = code
            it.target = self
            if code == "auto" { titled.append((it, "lang.auto")) }
            langMenu.addItem(it)
            langItems.append(it)
        }
        langConfigItem = item("lang.config", nil)
        langConfigItem.isEnabled = false
        langMenu.addItem(langConfigItem)
        let langItem = item("language", nil)
        langItem.submenu = langMenu
        menu.addItem(langItem)

        menu.addItem(.separator())
        reloadItem = item("reload", #selector(reload), "r")
        menu.addItem(reloadItem)
        let more = NSMenu()
        more.addItem(item("restartServer", #selector(restartServer)))
        more.addItem(item("openLogs", #selector(openLogs)))
        let moreItem = item("advanced", nil)
        moreItem.submenu = more
        menu.addItem(moreItem)

        menu.addItem(.separator())
        quitItem = item("quit", #selector(quit), "q")
        menu.addItem(quitItem)

        menu.delegate = self
        menu.autoenablesItems = false
        status.menu = menu
        applyLanguage()
    }

    /// Re-titles every item for `currentLang`. The pause title and data rows come from refreshTitles().
    func applyLanguage() {
        for (it, key) in titled { it.title = t(key) }
        if #available(macOS 14.4, *) { quitItem.subtitle = t("quit.sub") }
        refreshTitles()
        updateIcon()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        refreshTitles()
        fetchState()
    }

    func menuWillOpen(_ menu: NSMenu) { menuIsOpen = true }
    func menuDidClose(_ menu: NSMenu) { menuIsOpen = false }

    /// Debug only: the menu as text, to check titles and states without opening it.
    func dumpMenu(_ m: NSMenu, depth: Int) {
        for it in m.items where !it.isHidden {
            let title = it.isSeparatorItem ? "──" : (it.attributedTitle?.string ?? it.title)
            let flags = (it.state == .on ? "✓" : " ") + (it.isEnabled ? " " : "·")
            log("debug menu \(String(repeating: "  ", count: depth))\(flags) \(title)")
            if let sub = it.submenu { dumpMenu(sub, depth: depth + 1) }
        }
    }

    /// Rows are fixed when the menu opens; a later fetch only changes titles (the menu never resizes).
    func refreshTitles() {
        let on = isEnabled
        toggleItem.state = on ? .on : .off
        let manual = reasons.contains("manual")
        if let until = pausedUntil, until > Date() {
            let f = DateFormatter()
            f.dateFormat = Calendar.current.isDateInToday(until) ? "HH:mm" : "EEE HH:mm"
            f.locale = Locale(identifier: currentLang == .ms ? "ms_MY" : "en_US")
            pauseItem.title = t("pause.until", f.string(from: until))
        } else {
            pauseItem.title = t(manual ? "pause.manual" : "pause")
        }
        pauseItem.isEnabled = on
        resumeNowItem.isEnabled = pausedUntil != nil || manual
        reloadItem.isEnabled = on
        privacyItem.state = privacyManual ? .on : .off
        let zoomOnly = config.autoProcesses == HostConfig.defaultProcesses
        privacyAutoItem.title = t(zoomOnly ? "privacy.auto.zoom" : "privacy.auto.custom")
        privacyAutoItem.state = privacyAuto ? .on : .off
        if !menuIsOpen { privacyAutoItem.isHidden = config.autoProcesses.isEmpty }
        if #available(macOS 14.4, *) {
            privacyAutoItem.subtitle = sharingWith.map { zoomOnly ? t("privacy.active.zoom") : t("privacy.active.custom", $0) }
        }
        for it in daypartItems { it.state = (it.representedObject as? String) == daypart.rawValue ? .on : .off }
        notifyItem.state = notifyWaiting ? .on : .off
        let saved = prefs.string(forKey: "lang").flatMap(Lang.init(rawValue:))?.rawValue ?? "auto"
        for it in langItems {
            it.state = (it.representedObject as? String) == (config.lang?.rawValue ?? saved) ? .on : .off
            it.isEnabled = config.lang == nil
        }
        if !menuIsOpen { langConfigItem.isHidden = config.lang == nil }
        if let today {
            todayItem.title = t("today", today.sessions, today.subtasks)
        } else {
            todayItem.title = t("today.none")
        }

        if !serverUp {
            summaryItem.title = t("server.down")
        } else {
            let active = agents.filter { $0.mode == .active }.count
            let idle = agents.filter { $0.mode == .idle }.count
            let subs = agents.reduce(0) { $0 + $1.subagents }
            var parts = [t("sum.active", active), t("sum.idle", idle)]
            if !waiting.isEmpty { parts.append(t("sum.waiting", waiting.count)) }
            parts.append(t("sum.sub", subs))
            summaryItem.title = parts.joined(separator: " · ")
        }

        let list = waiting
        let now = Date()
        for (i, row) in waitRows.enumerated() {
            // While open, rows hidden at open time stay hidden: only titles change.
            if menuIsOpen && row.isHidden { continue }
            if i < maxWaitRows, i < list.count {
                let a = list[i]
                let what = t(a.mode == .permission ? "wait.permission" : "wait.input")
                let mins = a.waitingSince.map { max(0, Int(now.timeIntervalSince($0) / 60)) }
                let text = "⚠ \(a.name) — \(what)" + (mins.map { " · \($0) min" } ?? "")
                // Display only (disabled), but keep the label colour so it reads as an alert.
                row.attributedTitle = NSAttributedString(string: text, attributes: [
                    .foregroundColor: NSColor.labelColor,
                    .font: NSFont.menuFont(ofSize: 0),
                ])
                row.isHidden = false
            } else if i == maxWaitRows, list.count > maxWaitRows {
                row.attributedTitle = nil
                row.title = t("wait.more", list.count - maxWaitRows)
                row.isHidden = false
            } else if !menuIsOpen {
                row.isHidden = true
            } else {
                row.attributedTitle = nil
                row.title = "—"
            }
        }
    }
}

// MARK: - Options: privacy, day/night, notifications

enum Daypart: String { case auto, day, night }

/// What the page gets through `__wallpaper.setOptions`: enums and booleans only, never data strings.
var pageOptions = ""

extension AppDelegate {
    /// The menu choice once made; before that, config.json `privacy.default`.
    var privacyManual: Bool { prefs.object(forKey: "privacy") as? Bool ?? config.privacyDefault }
    var privacyAuto: Bool { prefs.object(forKey: "privacyAuto") as? Bool ?? true }
    var privacyOn: Bool { privacyManual || sharingWith != nil }
    var daypart: Daypart { Daypart(rawValue: prefs.string(forKey: "daypart") ?? "") ?? .auto }
    var notifyWaiting: Bool { prefs.bool(forKey: "notifyWaiting") }

    /// Rebuilds `pageOptions` and pushes it to every page that has not seen it.
    func buildOptions() -> String {
        "{privacy:\(privacyOn ? "true" : "false"),daypart:'\(daypart.rawValue)',lang:'\(currentLang.rawValue)'}"
    }

    func syncOptions() {
        pageOptions = buildOptions()
        walls.forEach { $0.updateOptions() }
    }

    /// Re-reads config.json when its size or mtime changed (polled from check()).
    func reloadConfigIfChanged() {
        let stamp = configStamp()
        guard stamp != configSeen else { return }
        configSeen = stamp
        let next = readConfig()
        guard next != config else { return }
        config = next
        log("config changed lang=\(config.lang?.rawValue ?? "auto") autoProcesses=\(config.autoProcesses.count)")
        updateLanguage()
        syncOptions()
        refreshTitles()
    }

    /// Applies a new language: menu titles at once, the page through setOptions (no reload).
    func updateLanguage() {
        let next = resolveLang(config)
        guard next != currentLang else { return }
        currentLang = next
        log("lang \(next.rawValue)")
        applyLanguage()
        syncOptions()
    }

    @objc func setLanguage(_ sender: NSMenuItem) {
        guard let code = sender.representedObject as? String else { return }
        if let l = Lang(rawValue: code) { prefs.set(l.rawValue, forKey: "lang") } else { prefs.removeObject(forKey: "lang") }
        updateLanguage()
        refreshTitles()
    }

    @objc func togglePrivacy() {
        prefs.set(!privacyManual, forKey: "privacy")
        log("privacy \(privacyManual ? "on" : "off") from menu")
        syncOptions()
    }

    @objc func togglePrivacyAuto() {
        prefs.set(!privacyAuto, forKey: "privacyAuto")
        if !privacyAuto { sharingWith = nil }
        log("privacy auto \(privacyAuto ? "on" : "off")")
        check()
        syncOptions()
    }

    @objc func setDaypart(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let d = Daypart(rawValue: raw) else { return }
        prefs.set(d.rawValue, forKey: "daypart")
        log("daypart \(d.rawValue)")
        syncOptions()
    }

    @objc func toggleNotify() {
        let on = !notifyWaiting
        prefs.set(on, forKey: "notifyWaiting")
        log("notify waiting \(on ? "on" : "off")")
        guard on else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            log("notification permission granted=\(granted)\(error.map { " error=\($0.localizedDescription)" } ?? "")")
        }
    }

    /// The first running process whose name is in config `privacy.autoProcesses` (exact match).
    /// The default list is Zoom's `CptHost`, which runs only while Zoom shares the screen.
    /// Process names need no TCC permission. Other apps are not detected unless listed.
    func runningAutoProcess() -> String? {
        let wanted = Set(config.autoProcesses)
        guard !wanted.isEmpty else { return nil }
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return nil }
        var pids = [pid_t](repeating: 0, count: Int(count) + 32)
        let n = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        guard n > 0 else { return nil }
        var name = [CChar](repeating: 0, count: 256)
        for pid in pids.prefix(Int(n)) where pid > 0 {
            guard proc_name(pid, &name, UInt32(name.count)) > 0 else { continue }
            let found = String(cString: name)
            if wanted.contains(found) { return found }
        }
        return nil
    }

    /// One banner per wait that lasts over 2 min. Nothing in privacy mode. The text is the
    /// agent name and the kind of wait; the banner has no actions.
    func notifyLongWaits() {
        let now = Date()
        let keys = Set(waiting.compactMap { a in a.waitingSince.map { "\(a.name)|\($0.timeIntervalSince1970)" } })
        notified.formIntersection(keys)                          // forget waits that ended
        guard notifyWaiting, !privacyOn else { return }
        for a in waiting {
            guard let since = a.waitingSince, now.timeIntervalSince(since) >= 120 else { continue }
            let key = "\(a.name)|\(since.timeIntervalSince1970)"
            guard !notified.contains(key) else { continue }
            notified.insert(key)
            let content = UNMutableNotificationContent()
            content.title = t("app")
            content.body = "\(a.name) \(t(a.mode == .permission ? "wait.permission" : "wait.input"))"
            let req = UNNotificationRequest(identifier: "wait-\(abs(key.hashValue))", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req) { error in
                if let error { log("notify failed: \(error.localizedDescription)") }
            }
            log("notified wait agent=\(a.name)")
        }
    }
}

// One copy at a time: launchd and a manual run can both start it.
let lockPath = NSTemporaryDirectory() + "io.github.imanhamka.quiet-office.host.lock"
let lockFD = open(lockPath, O_CREAT | O_RDWR, 0o600)
if lockFD < 0 || flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
    warn("another host instance holds \(lockPath); exiting")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)                   // no Dock icon, no menu bar
app.run()

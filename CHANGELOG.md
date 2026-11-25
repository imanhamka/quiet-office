# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-25

### Added

- Read-only Node server (zero dependencies, Node 22 or later). It reads Claude Code session files and streams state over Server-Sent Events on `127.0.0.1:47100`.
- Pixel-art office page, forked from pixel-agents v1.6.0, with a wallpaper mode: canvas only, input ignored, capped at 12/10 fps, frame skipping.
- Sub-agents walk in to their own desks, then move to team rooms with door signs.
- Lounge for idle agents, an all-done stretch, an end-of-day whiteboard, a real clock and day/night lighting.
- Reception desk with a mail envelope for a chat-relay agent (Claude Code channel plugins).
- Today stats: sessions and sub-tasks started today.
- Waiting agents: red PC screen and ring for permission waits, a menu/tray list, and an optional notification after 2 minutes.
- Privacy mode, plus auto privacy during screen sharing where the host detects it.
- English and Bahasa Melayu, picked from the system language or `config.json`.
- `config.json` for language, aliases, reception, privacy and context size.
- macOS host (stable): Swift + WKWebView behind the desktop icons, menu bar item, LaunchAgents.
- Windows host (experimental): .NET 10 WinForms + WebView2 on the WorkerW desktop layer, tray icon.
- Linux host (experimental): Python 3 + GTK 3 + WebKit2GTK 4.1, X11 and wlroots/KDE Wayland (layer-shell), tray icon.
- Demo mode (`?wallpaper=1&demo=1`) with fixture agents.

[Unreleased]: https://github.com/imanhamka/quiet-office/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/imanhamka/quiet-office/releases/tag/v1.0.0

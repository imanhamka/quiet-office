# Privacy

Quiet Office watches your Claude Code sessions. It never touches them.
This page lists everything it reads, sends, shows and writes.

## What the server reads

All paths are under the Claude config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.

| Input | What it uses |
|---|---|
| `sessions/*.json` | Session id, name, cwd, pid, status, status time. |
| Transcript `.jsonl` tails | Tool names and inputs (to build a verb + basename), tool results (error flag only), token usage, channel message markers. The first read takes the last 256 KB. Later reads take only new bytes. |
| Sub-agent `subagents/` files | Agent type and the finished flag. |
| File timestamps | Today's session and sub-task counts. |
| `config.json` | See [config.md](config.md). |

The hosts also read process names to detect screen sharing (`privacy.autoProcesses`, default `CptHost`, Zoom's sharing helper). They never read window titles or screen contents.

## What goes to the page

| Sent | Example |
|---|---|
| Agent display name | `api-gateway` |
| Mode | `active`, `idle`, `permission`, `input` |
| Tool verb + file basename | `Reading server.ts`, `Running command` |
| Sub-agent type | `Subtask: Explore` |
| Error booleans | `error: true` |
| Token counts | `{ tokens: 48211, max: 200000 }` |
| Today counts | `{ sessions: 6, subtasks: 14 }` |
| Mail event | agent id only |

| Never sent |
|---|
| Command text |
| File contents and full paths |
| Prompts and assistant text |
| Sub-agent task descriptions |
| Message text and message senders |

## What it never does

- Installs no hooks.
- Writes nothing under the Claude config directory.
- Changes no Claude Code settings.
- Sends no input to a session and approves no tool.
- Connects to nothing beyond `127.0.0.1`.
- Collects no telemetry.

## What it writes

| File | Owner |
|---|---|
| Host settings | macOS: `defaults` domain `io.github.imanhamka.quiet-office`. Linux: `${XDG_CONFIG_HOME:-~/.config}/quiet-office/host-state.json` (0600). Windows: `%APPDATA%\quiet-office\host-state.json`. |
| Logs | macOS `~/Library/Logs/quiet-office/`, Linux `${XDG_STATE_HOME:-~/.local/state}/quiet-office/`, Windows `%LOCALAPPDATA%\quiet-office\logs\`. |
| Single-instance lock | macOS: `$TMPDIR/io.github.imanhamka.quiet-office.host.lock`. Linux: `quiet-office-host-<uid>.lock` in `$XDG_RUNTIME_DIR` (else the temp directory). Windows: a named mutex, no file. |
| Web view data | macOS and Linux: none (non-persistent, in memory). Windows: the WebView2 profile at `%LOCALAPPDATA%\quiet-office\webview2\` (cache and local storage of the local page only). |
| Service files | Written by the install scripts only: LaunchAgents, systemd user unit, XDG autostart, HKCU `Run` key. |

`config.json` belongs to you. Quiet Office reads it and never writes it.

## What shows on your desktop

The default view shows agent names and file basenames. Anyone who sees your screen sees them.

| Control | Effect |
|---|---|
| Privacy mode | Hides names, status labels and sub-agent tags. Door signs show busy or empty only. Counts stay. |
| `privacy.default: true` | Starts in privacy mode. |
| Auto privacy | Turns privacy mode on while a process from `privacy.autoProcesses` runs. Default: Zoom's `CptHost`. |
| Notifications | Off by default. They show the agent name. None in privacy mode. |

## Before you file an issue

- Host and server logs contain agent names. Redact them.
- `GET /state` output contains agent names and file basenames. Redact them.
- Screenshots: use demo mode (`?wallpaper=1&demo=1`), never a capture of real sessions.

## Local access

The server has no auth. Any local process can read `/state` and `/events`.
The Host check blocks web pages in your browser from reading them (DNS rebinding).
It does not block other programs on the same machine.

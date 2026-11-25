# Data contract

This is the wire contract between the server, the page and the native hosts.
Every component codes against this file. Change it first, then the code.

- [Server endpoints](#server-endpoints)
- [Server-Sent Events](#server-sent-events)
- [Agent naming](#agent-naming)
- [GET /state](#get-state)
- [Quiet Office messages](#quiet-office-messages)
- [Layout metadata](#layout-metadata)
- [Page behaviour in wallpaper mode](#page-behaviour-in-wallpaper-mode)
- [Caching](#caching)
- [Privacy rules on the wire](#privacy-rules-on-the-wire)

The host-to-page part (URL, `window.__wallpaper`, menu items) lives in [adding-a-host.md](adding-a-host.md).

## Repository layout

| Path | Role |
|---|---|
| `server/` | Zero-dependency Node server (Node 22 or later). Reads Claude Code files, serves the page and SSE. |
| `web/pixel-agents/` | Fork of pixel-agents v1.6.0 (commit `4dd14d6`, MIT). Only `webview-ui` and `core` are used. Build output: `web/dist/`. |
| `hosts/macos/` | Swift + WKWebView host. |
| `hosts/windows/` | C# / .NET 10 + WebView2 host (experimental). |
| `hosts/linux/` | Python 3 + GTK 3 + WebKit2GTK 4.1 host (experimental). |
| `scripts/<os>/` | Build, install and uninstall scripts per OS. |

## Server endpoints

The server binds `127.0.0.1:<port>` only. The port is `47100`, or `QUIET_OFFICE_PORT`.

| Rule | Behaviour |
|---|---|
| Host header | Anything other than `127.0.0.1:<port>` or `localhost:<port>` gets `403`. |
| Methods | `GET` and `HEAD` only. Anything else gets `405` with `Allow: GET, HEAD`. |
| CORS | No CORS headers. |

| Endpoint | Response |
|---|---|
| `GET /` and static files | The built page from `web/dist/`. |
| `GET /healthz` | `ok` (text). |
| `GET /events` | Server-Sent Events stream. |
| `GET /state` | JSON snapshot for hosts and debugging. |

Assets (floors, walls, furniture, layout, characters) do not come from the server as messages.
The page loads them itself from `web/dist/assets/`.

## Server-Sent Events

Each event is `data: <JSON message>\n\n`. A heartbeat comment `:\n\n` goes out every 15 s.

On connect the server sends a full snapshot, then live deltas:

1. `existingAgents`.
2. `agentCreated` for each agent.
3. Current tool starts and status.
4. `wallpaperConfig` and `wallpaperStats`.

The base message shapes are pixel-agents' own, defined in `web/pixel-agents/core/src/messages.ts`:

| Message | Meaning |
|---|---|
| `agentCreated` / `agentClosed` / `existingAgents` | Agent lifecycle. |
| `agentStatus` | Mode change (`active`, `idle`, `permission`, `input`). |
| `agentToolStart` / `agentToolDone` / `agentToolsClear` | Tool activity. |
| `agentToolPermission` / `agentToolPermissionClear` | A tool waits for the user's permission. |
| `subagentToolStart` / `subagentToolDone` / `subagentClear` / `subagentToolPermission` | Sub-agent activity. |
| `agentContextUsage` | Context tokens in use and the max. |

Quiet Office adds optional fields to the base messages:

| Field | On | Value |
|---|---|---|
| `error: true` | `agentToolDone` | The tool result had `is_error`. Boolean only, never the error text. |
| `waitingSince` | `agentStatus` (waiting modes), `agentToolPermission` | ms epoch, from the session's `statusUpdatedAt`. |

Context usage comes from the latest main-chain `message.usage`: input + cache read + cache creation tokens.
The max is `contextMax` from `config.json` (default `200000`), or 1,000,000 for a 1M-context model.

Sub-agent status label: `Subtask: <agentType>`. It never carries the task description, because that text comes from a prompt.
A sub-agent is done when `meta.finished === true`, when the parent gets its tool result, or after 60 s idle.

Status strings stay English on the wire. The page translates them for display.

## Agent naming

`agentCreated.directoryName` follows the first rule that matches:

1. The session `name`, when `nameSource !== 'derived'`.
2. The tmux session name (the part before `:`).
3. `basename(cwd)`, when `cwd` is not `$HOME`.
4. A short fallback built from the first 4 characters of the session id.

`config.json` `aliases` apply last:

- An exact key match on the name wins.
- Else the longest key that is a prefix of the name.
- Else the same two checks against the `cwd` basename.

Names are cut to 24 characters.

`directoryName` is fixed at `agentCreated`. A rename therefore re-announces the agent:

1. `agentToolsClear` and `agentClosed` for the old id.
2. `agentCreated` and current state under a new id.

Explicit session names (`nameSource !== 'derived'`) rename this way when they change.
Derived names rename only when the aliases change.

## GET /state

```json
{
  "agents": [
    {
      "id": 1,
      "name": "api-gateway",
      "mode": "permission",
      "waitingSince": 1795000000000,
      "transcriptFound": true,
      "context": { "tokens": 48211, "max": 200000 },
      "tools": [{ "toolId": "t1", "toolName": "Bash", "status": "Running command", "runInBackground": false }],
      "subagents": []
    }
  ],
  "today": { "day": "2026-11-25", "sessions": 6, "subtasks": 14 }
}
```

| Field | Type |
|---|---|
| `mode` | `active` \| `idle` \| `permission` \| `input` |
| `waitingSince` | ms epoch or `null` |
| `context` | `{ tokens, max }` or `null` |

The same privacy rules as `/events` apply. Hosts poll it every 10 s and when the menu opens.
Hosts keep only `name`, `mode`, `waitingSince` and the sub-agent count.

## Quiet Office messages

These types are wallpaper-only. Upstream pixel-agents code ignores them.

| Message | Shape | When |
|---|---|---|
| `wallpaperConfig` | `{ type, reception: string \| null, lang: 'en' \| 'ms' \| null }` | On connect and when `config.json` changes. `lang: null` means auto. |
| `wallpaperStats` | `{ type, day: 'YYYY-MM-DD', sessions: number, subtasks: number }` | On connect and when a count changes. |
| `wallpaperMail` | `{ type, id: number }` | Once per new inbound channel message for the reception agent. Live only, never replayed on connect. |

`wallpaperStats` counts:

- `sessions`: distinct sessions with a transcript modified today (local time).
- `subtasks`: sub-agent transcripts created today.
- Counts come from file timestamps, so a server restart loses nothing. Counts only, no names.

`wallpaperMail` rules:

- It goes only to the agent named by `config.json` `reception.agent`.
- It fires only for channel messages whose plugin server is in `reception.channels`. An empty list means any server.
- It carries no text and no sender.

## Layout metadata

The layout JSON can carry these optional top-level keys:

| Key | Shape | Meaning |
|---|---|---|
| `wallpaperRooms` | room list | Overrides the team rooms. Default: the labelled `areaTiles` areas. |
| `wallpaperEntrance` | `{ col, row }` | Where sub-agents walk in and out. |
| `wallpaperReception` | `{ col, row }` | The reception desk tile. No agent name lives in the layout. |

The reception desk stays empty unless `config.json` `reception.agent` is set.
The agent whose display name equals it (case-insensitive, after aliases) sits there instead of at a desk.

Door signs:

- The canvas draws them, at least 40 px wide.
- A sign widens to fit the room lead's name, up to the room width, then cuts the name with `..`.
- A sign stays inside its room's columns. Overlay labels slide aside so they never cover a sign.

## Page behaviour in wallpaper mode

`?wallpaper=1` turns on wallpaper mode:

- Canvas only: no toolbars, cards, modals or sound.
- Input is ignored.
- DPR is forced to 1, with `image-rendering: pixelated`.
- fps is capped: 12 while anyone walks or spawns, 10 otherwise.
- Frame skip: the renderer draws into a recorder. A frame whose draw calls match the last drawn frame leaves the canvas untouched. Images compare by identity, so caches must create a new canvas when content changes, never redraw one in place. See [performance.md](performance.md).

Privacy mode (`setOptions({ privacy: true })`):

- No overlay labels: no status, no names, no sub-agent tags.
- Door signs show a busy or empty label, never the lead's name.
- Whiteboard counts stay.
- Nothing else that shows a name.

## Caching

- Every file gets `Cache-Control: no-cache`.
- The exception is Vite output with a content hash (`/assets/<name>-<8 chars>.js|css`). Those get `immutable`.
- `/events` and `/state` get `no-store`.
- Hosts clear the web view cache before each load. A rebuilt layout or sprite shows on the next reload.

## Privacy rules on the wire

- Never sent: command text, file contents, prompts, task descriptions, message text, message senders.
- Status strings are a tool verb plus a file basename, for example `Reading server.ts`, `Running command`, `Searching code`.
- Error flags are booleans.
- Mail events carry an agent id only.

See [privacy.md](privacy.md) for what the server reads and writes.

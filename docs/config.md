# Config

Quiet Office works with no config. Every key is optional.

## config.json location

| OS | Path |
|---|---|
| macOS, Linux | `${XDG_CONFIG_HOME:-~/.config}/quiet-office/config.json` |
| Windows | `%APPDATA%\quiet-office\config.json` |

- The server and the hosts read it. Nothing writes it.
- A missing or invalid file means defaults.
- The server polls its modification time and size. Changes apply without a restart.
- A file over 1 MB counts as missing.
- A field of the wrong type falls back to that field's default. The other fields still apply.

## Schema

```jsonc
{
  "lang": "auto",
  "aliases": { "my-repo-dir": "Nice Name" },
  "reception": { "agent": null, "channels": [] },
  "privacy": { "default": false, "autoProcesses": ["CptHost"] },
  "contextMax": 200000
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `lang` | `"auto"` \| `"en"` \| `"ms"` | `"auto"` | Page and menu language. `auto` follows the system language. |
| `aliases` | object of string → string | `{}` | Display names. Exact key first, then the longest key that prefixes the name, then the same against the `cwd` basename. A change renames live agents. |
| `reception.agent` | string or `null` | `null` | Display name of the agent that sits at the reception desk. `null` leaves the desk empty. Case-insensitive, matched after aliases. |
| `reception.channels` | array of strings | `[]` | Claude Code channel plugin server names that trigger the mail envelope. `[]` means any. |
| `privacy.default` | boolean | `false` | Start in privacy mode. |
| `privacy.autoProcesses` | array of strings | `["CptHost"]` | Process names that turn on privacy mode while they run. Hosts that cannot detect processes ignore it. |
| `contextMax` | number | `200000` | Context window size for the context bar. 1M-context models use 1,000,000. |

### Example: a chat-relay agent at reception

```json
{
  "aliases": { "chat-relay": "Relay" },
  "reception": { "agent": "Relay", "channels": [] }
}
```

The agent shown as `Relay` sits at the reception desk. An envelope appears each time a channel message reaches its session.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `QUIET_OFFICE_PORT` | `47100` | Server port. Hosts use it to build the page URL. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config directory. `CLAUDE_HOME` works as a fallback alias. |
| `QUIET_OFFICE_WEB_DIR` | `web/dist` | Directory the server serves the page from. |
| `QUIET_OFFICE_CONTEXT_MAX` | unset | Overrides `config.json` `contextMax`. |
| `QUIET_OFFICE_DEBUG` | unset | `1` turns on debug logs. Debug logs contain agent names. |
| `QUIET_OFFICE_COVER_THRESHOLD` | `0.90` | Tests only. Coverage ratio that pauses the page. Above 1 never pauses. |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for `config.json` on macOS and Linux. |
| `XDG_STATE_HOME` | `~/.local/state` | Base directory for logs on Linux. |

## Host settings

Menu and tray choices (on/off, pause timer, privacy, day/night, notify, language override) are host settings, not `config.json`.

| OS | Where |
|---|---|
| macOS | `defaults read io.github.imanhamka.quiet-office` |
| Windows | `%APPDATA%\quiet-office\host-state.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/quiet-office/host-state.json` |

## Logs

| OS | Directory |
|---|---|
| macOS | `~/Library/Logs/quiet-office/` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/quiet-office/` |
| Windows | `%LOCALAPPDATA%\quiet-office\logs\` |

## URL parameters

These are for hosts and for testing in a browser.

| Parameter | Meaning |
|---|---|
| `wallpaper=1` | Wallpaper mode. |
| `demo=1` | Fixture agents instead of live data. |
| `screen=<n>` | Screen index. |
| `inset=<t,r,b,l>` | Safe area. |
| `lang=<en\|ms>` | Language override. |

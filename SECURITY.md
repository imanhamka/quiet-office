# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |
| < 1.0 | No |

## Report a vulnerability

Do not open a public issue for a security bug.

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**. This creates a private advisory that only the maintainer sees.
3. Describe the bug, the platform, and the steps to reproduce it.
4. Redact agent names, paths and file names from any log or `/state` output you attach.

This is a personal project maintained in spare time, so replies are best effort. A fix ships in a patch release, then the advisory goes public.

## Security model

Quiet Office is read-only by design. See [docs/privacy.md](docs/privacy.md) for the full list.

- **Server:** binds `127.0.0.1` only. It answers `GET` and `HEAD` only (`405` otherwise).
- **Host header:** the server rejects any `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (`403`). This blocks DNS-rebinding pages.
- **Headers:** no CORS headers. The server sends CSP, `Cross-Origin-Resource-Policy` and `Referrer-Policy` headers.
- **Agents:** no hooks, no writes under the Claude config directory, no input to sessions, no tool approvals.
- **Network:** nothing leaves `127.0.0.1`. No telemetry.
- **Hosts:** the web view only navigates to `http://127.0.0.1:<port>/`. Pop-up windows are blocked.

## Known limits

- **No auth on loopback.** Any local process running as any user on the machine can read `GET /state` and `GET /events`. The data is agent names, modes, tool verbs, file basenames and counts.
- **Agent names in logs.** Host and server logs contain agent names. Redact them before you share a log.
- **Agent names on screen.** The default view shows agent names and file basenames on the desktop. Turn on privacy mode to hide them.
- **Notifications.** "Notify when an agent waits > 2 min" shows the agent name. It is off by default and silent in privacy mode.
- **Undocumented input.** The server reads Claude Code's internal session registry (`~/.claude/sessions`). The format is not a public API and can change in any release.
- **macOS private API.** The macOS host calls private WebKit selectors. A macOS update can remove them. The host then logs a warning and the page can freeze.

These limits are in scope for discussion, but they are not vulnerabilities by themselves.

# Contributing to Quiet Office

Thanks for helping. Bug reports, host testing on Windows and Linux, translations and fixes are all welcome.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

These rules decide whether a change can merge.

- **Read-only stays read-only.** No hooks, no writes under the Claude config directory, no settings changes, no input to sessions, no tool approvals.
- **Local only.** No network beyond `127.0.0.1`. No telemetry. The server answers `GET` and `HEAD` only.
- **Privacy on the wire.** The page gets names, modes, tool verbs + file basenames, booleans and counts. Never command text, file contents, prompts, descriptions or message text.
- **Contract first.** Change [docs/data-contract.md](docs/data-contract.md) or [docs/adding-a-host.md](docs/adding-a-host.md) before the code.
- **Two languages.** Every new UI string needs English and Bahasa Melayu. Ask in the PR if you need help with the Malay text.
- **Demo data only.** Screenshots, fixtures and tests use demo names (`api-gateway`, `billing-service`, `docs-site`). Never real projects, people or paths.
- **Server has zero dependencies.** Use the Node standard library only.

## Repository layout

| Path | What | Language |
|---|---|---|
| `server/` | Read-only data server | Node 22+, ES modules, no deps |
| `web/pixel-agents/` | Office page (pixel-agents fork) | TypeScript, React, Vite |
| `hosts/macos/` | macOS host | Swift |
| `hosts/windows/`, `hosts/windows.Tests/` | Windows host and its logic tests | C#, .NET 10 |
| `hosts/linux/` | Linux host | Python 3, GTK 3 |
| `scripts/<os>/` | Build and install scripts | Shell, PowerShell |
| `docs/` | Architecture and contracts | Markdown |

## Set up

You need Node.js 22 or later and git.

```sh
git clone https://github.com/imanhamka/quiet-office.git
cd quiet-office
cd web/pixel-agents && npm ci --ignore-scripts && cd ../..
```

`--ignore-scripts` is deliberate: no dependency install script runs on your machine.

## Run the checks

| Area | Command |
|---|---|
| Server | `node --test server/test/` |
| Web lint | `cd web/pixel-agents && npm run lint` |
| Web types | `cd web/pixel-agents && npm run typecheck` |
| Web tests | `cd web/pixel-agents && npm test` |
| Web build | `cd web/pixel-agents && npm run build` (output: `web/dist/`) |
| macOS host | `scripts/macos/build-host.sh` |
| Windows host | `dotnet build hosts/windows/QuietOffice.csproj -c Release` (Windows only) |
| Windows host logic | `dotnet test hosts/windows.Tests/QuietOffice.Tests.csproj` (any OS) |
| Linux host | `sh hosts/linux/test/run-selftest.sh` (needs `xvfb-run` and the GTK packages, or the Docker image in `hosts/linux/test/`) |

CI runs the same commands. See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Run it locally

```sh
cd web/pixel-agents && npm run build && cd ../..
QUIET_OFFICE_PORT=47199 node server/server.mjs
```

- Demo data: <http://127.0.0.1:47199/?wallpaper=1&demo=1>
- Live data: <http://127.0.0.1:47199/?wallpaper=1>
- State: `curl -s http://127.0.0.1:47199/state`

Use a port other than 47100 while an installed copy runs.
Point `CLAUDE_CONFIG_DIR` at an empty directory to test with no sessions.

## Code style

- Match the code around you. `.editorconfig` sets indent and line endings.
- Web: ESLint and Prettier configs live in `web/pixel-agents/`.
- Mark every change to upstream pixel-agents code with a `quiet-office:` comment. It keeps upstream merges tractable.
- Comments explain why, not what.
- Delete dead code. Do not comment it out.

## Pull requests

1. Open an issue first for anything bigger than a bug fix.
2. Keep one change per PR.
3. Fill in the PR checklist.
4. Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
5. CI must be green.

## Reporting bugs

Use the bug report form. Redact agent names, project names, paths and file names from logs and `/state` output.

Security bugs go through [SECURITY.md](SECURITY.md), never a public issue.

## Licence

Contributions are licensed under the [MIT License](LICENSE).

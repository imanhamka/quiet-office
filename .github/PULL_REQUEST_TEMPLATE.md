## What and why

<!-- One or two sentences. Link the issue: Fixes #123 -->

## Checklist

- [ ] `node --test server/test/` passes (if `server/` changed).
- [ ] `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass in `web/pixel-agents` (if `web/` changed).
- [ ] The host builds (if `hosts/` changed): macOS `scripts/macos/build-host.sh`, Windows `dotnet build hosts/windows/QuietOffice.csproj` + `dotnet test hosts/windows.Tests/QuietOffice.Tests.csproj`, Linux selftest.
- [ ] [docs/data-contract.md](../docs/data-contract.md) is updated first if a message, endpoint or `config.json` key changed.
- [ ] Still read-only: no hooks, no writes under the Claude config directory, no input to sessions, no network beyond `127.0.0.1`.
- [ ] Nothing sent to the page beyond names, modes, tool verbs + basenames, booleans and counts.
- [ ] New UI strings exist in English and Bahasa Melayu.
- [ ] Screenshots, if any, use demo mode (`?wallpaper=1&demo=1`).
- [ ] No real names, paths or hostnames in code, tests, fixtures or commit text.
- [ ] `CHANGELOG.md` has an entry under `Unreleased`.

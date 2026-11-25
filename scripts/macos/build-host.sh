#!/bin/bash
# Builds hosts/macos/build/QuietOffice.app from hosts/macos/QuietOffice.swift (swiftc -O, ad-hoc signed).
# Fails on any compiler warning.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/hosts/macos/QuietOffice.swift"
APP="$ROOT/hosts/macos/build/QuietOffice.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>io.github.imanhamka.quiet-office</string>
	<key>CFBundleName</key>
	<string>Quiet Office</string>
	<key>CFBundleDisplayName</key>
	<string>Quiet Office</string>
	<key>CFBundleExecutable</key>
	<string>QuietOffice</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.1</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleLocalizations</key>
	<array>
		<string>en</string>
		<string>ms</string>
	</array>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSAppSleepDisabled</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
</dict>
</plist>
PLIST
plutil -lint -s "$APP/Contents/Info.plist"

LOG="$(mktemp -t quiet-office-swiftc)"
trap 'rm -f "$LOG"' EXIT
if ! swiftc -O -target "$(uname -m)-apple-macos13.0" \
    -framework Cocoa -framework WebKit \
    -o "$APP/Contents/MacOS/QuietOffice" "$SRC" 2>"$LOG"; then
    cat "$LOG" >&2
    exit 1
fi
if grep -q "warning:" "$LOG"; then
    cat "$LOG" >&2
    echo "build-host: compiler warnings in $SRC; fix them first" >&2
    exit 1
fi

codesign -s - --force "$APP"
codesign --verify "$APP"
echo "built $APP"

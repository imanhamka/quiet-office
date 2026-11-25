#!/bin/bash
# Installs and starts the two Quiet Office LaunchAgents (server first, then host).
# Run scripts/macos/build.sh first. Safe to run again: loaded agents are replaced.
# --dry-run: render and lint the plists into a temp directory, print them, load nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/macos"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/quiet-office"
PREFIX="io.github.imanhamka.quiet-office"
DRY=0
case "${1:-}" in
    "") ;;
    --dry-run) DRY=1 ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

die() { echo "install: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "macOS only; see scripts/ for other systems"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found in PATH; install Node.js 22 or newer"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die "$NODE is Node.js $NODE_MAJOR; Node.js 22 or newer is required"
APP_BIN="$ROOT/hosts/macos/build/QuietOffice.app/Contents/MacOS/QuietOffice"
[ -x "$APP_BIN" ] || die "$APP_BIN missing; run scripts/macos/build.sh first"
[ -f "$ROOT/web/dist/index.html" ] || die "$ROOT/web/dist/index.html missing; run scripts/macos/build.sh first"

# Values go into XML <string> elements, so &, < and > are escaped. Perl takes them from the
# environment, so no character in a path is special to the substitution.
render() {
    QO_HOME="$HOME" QO_ROOT="$ROOT" QO_NODE="$NODE" perl -pe '
        BEGIN { sub x { my $v = shift; $v =~ s/&/&amp;/g; $v =~ s/</&lt;/g; $v =~ s/>/&gt;/g; $v } }
        s/__HOME__/x($ENV{QO_HOME})/ge; s/__ROOT__/x($ENV{QO_ROOT})/ge; s/__NODE__/x($ENV{QO_NODE})/ge;
    ' "$1" > "$2"
    plutil -lint -s "$2"
}

TMP="$(mktemp -d -t quiet-office-install)"
trap 'rm -rf "$TMP"' EXIT
for name in server host; do
    render "$HERE/$PREFIX.$name.plist" "$TMP/$PREFIX.$name.plist"
done

if [ "$DRY" = 1 ]; then
    for name in server host; do echo "== $LA/$PREFIX.$name.plist"; cat "$TMP/$PREFIX.$name.plist"; done
    echo "dry run: nothing installed"
    exit 0
fi

mkdir -p "$LOGS" "$LA"
DOMAIN="gui/$(id -u)"
for name in server host; do
    label="$PREFIX.$name"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    cp "$TMP/$label.plist" "$LA/$label.plist"
    launchctl bootstrap "$DOMAIN" "$LA/$label.plist"
done
echo "installed. node: $NODE. logs: $LOGS"

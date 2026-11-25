#!/bin/bash
# Stops and removes the two Quiet Office LaunchAgents. Safe to run again.
# Keeps the repo, config.json, logs and saved menu state unless --purge is given.
set -euo pipefail

PREFIX="io.github.imanhamka.quiet-office"
LA="$HOME/Library/LaunchAgents"
PURGE=0
case "${1:-}" in
    "") ;;
    --purge) PURGE=1 ;;
    *) echo "usage: $0 [--purge]" >&2; exit 2 ;;
esac

case "${XDG_CONFIG_HOME:-}" in
    /*) CONFIG_DIR="$XDG_CONFIG_HOME/quiet-office" ;;
    *) CONFIG_DIR="$HOME/.config/quiet-office" ;;
esac

DOMAIN="gui/$(id -u)"
for name in host server; do
    label="$PREFIX.$name"
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
        launchctl bootout "$DOMAIN/$label"
    fi
    rm -f "$LA/$label.plist"
done

if [ "$PURGE" = 1 ]; then
    rm -rf "$HOME/Library/Logs/quiet-office"
    rm -rf "$CONFIG_DIR"
    defaults delete "$PREFIX" 2>/dev/null || true
    echo "uninstalled; logs, config and saved menu state removed."
else
    echo "uninstalled; kept logs (~/Library/Logs/quiet-office), config and saved menu state. --purge removes them."
fi

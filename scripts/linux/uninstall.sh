#!/usr/bin/env bash
# Removes what scripts/linux/install.sh added. Keeps config.json, host-state.json and logs
# unless --purge is given.
set -euo pipefail

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "uninstall.sh: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

REPO=$(cd "$(dirname "$0")/../.." && pwd)
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
CONFIG_DIR=$CONFIG_HOME/quiet-office
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/quiet-office
UNIT=quiet-office-server.service
UNIT_FILE=$CONFIG_HOME/systemd/user/$UNIT
DESKTOP_FILE=$CONFIG_HOME/autostart/quiet-office-host.desktop

if command -v systemctl >/dev/null; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
fi
rm -f "$UNIT_FILE" "$DESKTOP_FILE"
command -v systemctl >/dev/null && systemctl --user daemon-reload || true

# Stop a running host started from this repo (own processes only).
pkill -u "$(id -u)" -f "$REPO/hosts/linux/quiet_office.py" 2>/dev/null || true

echo "Removed $UNIT_FILE"
echo "Removed $DESKTOP_FILE"
if [ "$PURGE" = 1 ]; then
  rm -rf "$CONFIG_DIR" "$STATE_DIR"
  echo "Purged $CONFIG_DIR and $STATE_DIR"
else
  echo "Kept $CONFIG_DIR and $STATE_DIR (use --purge to remove them)"
fi

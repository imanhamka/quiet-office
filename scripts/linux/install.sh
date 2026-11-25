#!/usr/bin/env bash
# Installs Quiet Office for the current Linux user (experimental):
#   - systemd user unit quiet-office-server.service (node server, 127.0.0.1 only)
#   - XDG autostart entry for the desktop host (hosts/linux/quiet_office.py)
# Usage: scripts/linux/install.sh [--no-start]
# Nothing runs as root. Package installs are printed for you to run; this script never runs them.
set -euo pipefail

START=1
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

die() { echo "install.sh: $*" >&2; exit 1; }

REPO=$(cd "$(dirname "$0")/../.." && pwd)
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/quiet-office
UNIT_DIR=$CONFIG_HOME/systemd/user
AUTOSTART_DIR=$CONFIG_HOME/autostart
UNIT=quiet-office-server.service

# Unit files and .desktop Exec lines treat these characters specially; refuse them rather than escape.
case "$REPO" in
  *[\"\'\\\$\`%\ ]*) die "repo path '$REPO' contains a space, quote, \\, \$, \` or %: move the repo and retry" ;;
esac

NODE=$(command -v node) || die "node not found on PATH: install Node.js 22 or newer"
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "node $("$NODE" --version) at $NODE is too old: Quiet Office needs Node.js 22 or newer"
PYTHON=$(command -v python3) || die "python3 not found on PATH"
command -v systemctl >/dev/null || die "systemctl not found: this installer needs a systemd user session"

echo "Checking libraries for the host:"
missing_required=0
check_lib() { # name version required(1|0) what
  if "$PYTHON" -c "import gi; gi.require_version('$1', '$2'); from gi.repository import $1" 2>/dev/null; then
    echo "  ok       $1 $2"
  elif [ "$3" = 1 ]; then
    echo "  MISSING  $1 $2 ($4)"; missing_required=1
  else
    echo "  absent   $1 $2 ($4, optional)"
  fi
}
check_lib Gtk 3.0 1 "GTK 3"
check_lib WebKit2 4.1 1 "WebKitGTK 4.1"
check_lib GtkLayerShell 0.1 0 "Wayland placement on wlroots, Hyprland, KDE"
check_lib AyatanaAppIndicator3 0.1 0 "tray menu"
check_lib Wnck 3.0 0 "X11: pause when windows cover the desktop"
"$PYTHON" -c "import cairo" 2>/dev/null && echo "  ok       pycairo" || echo "  absent   pycairo (click-through windows, optional)"

cat <<'EOF'

Packages (required first, then optional):
  Debian/Ubuntu: python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1
                 python3-gi-cairo gir1.2-gtklayershell-0.1 gir1.2-ayatanaappindicator3-0.1 gir1.2-wnck-3.0
  Fedora:        python3-gobject gtk3 webkit2gtk4.1
                 python3-cairo gtk-layer-shell libayatana-appindicator-gtk3 libwnck3
  Arch:          python-gobject gtk3 webkit2gtk-4.1
                 python-cairo gtk-layer-shell libayatana-appindicator libwnck3
GNOME needs the AppIndicator shell extension to show the tray icon.
EOF
[ "$missing_required" = 0 ] || die "install the required packages above, then run this script again"

[ -f "$REPO/web/dist/index.html" ] || echo "warning: $REPO/web/dist is missing: build the web page before the host can show it" >&2

mkdir -p "$UNIT_DIR" "$AUTOSTART_DIR"
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"

# %S is the user state directory (XDG_STATE_HOME); StateDirectory= creates %S/quiet-office.
cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Quiet Office data server (read-only, 127.0.0.1)

[Service]
ExecStart=$NODE $REPO/server/server.mjs
Restart=on-failure
RestartSec=5
StateDirectory=quiet-office
StandardOutput=append:%S/quiet-office/server.log
StandardError=inherit
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF

cat > "$AUTOSTART_DIR/quiet-office-host.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Quiet Office
Comment=Pixel-art office wallpaper that shows coding sessions (read-only)
Exec=$PYTHON $REPO/hosts/linux/quiet_office.py --log
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

echo
echo "Wrote $UNIT_DIR/$UNIT"
echo "Wrote $AUTOSTART_DIR/quiet-office-host.desktop"
systemctl --user daemon-reload
if [ "$START" = 1 ]; then
  systemctl --user enable --now "$UNIT"
  echo "Server started. Check: curl -s http://127.0.0.1:${QUIET_OFFICE_PORT:-47100}/healthz"
  echo "The host starts at next login. Start it now: $PYTHON $REPO/hosts/linux/quiet_office.py --log &"
else
  systemctl --user enable "$UNIT"
  echo "Enabled; nothing started (--no-start)."
fi
echo "Logs: $STATE_DIR"
echo "NVIDIA tip: if the wallpaper stays blank, add WEBKIT_DISABLE_DMABUF_RENDERER=1 before the Exec command."

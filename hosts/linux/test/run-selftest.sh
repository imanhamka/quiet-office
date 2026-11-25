#!/bin/sh
# Runs the Linux host selftest against a container-local server with no sessions.
# Env: REPO (default /repo), WEB_DIR (default $REPO/web/dist), PORT (default 47210).
set -eu
REPO=${REPO:-/repo}
WEB_DIR=${WEB_DIR:-$REPO/web/dist}
PORT=${PORT:-47210}
EMPTY=$(mktemp -d)
[ -f "$WEB_DIR/index.html" ] || { echo "selftest: no web build at $WEB_DIR (run the web build first)" >&2; exit 2; }

QUIET_OFFICE_PORT=$PORT QUIET_OFFICE_WEB_DIR=$WEB_DIR \
  CLAUDE_CONFIG_DIR=$EMPTY node "$REPO/server/server.mjs" > "$EMPTY.server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
i=0
until curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 50 ] || { echo "selftest: server did not start" >&2; cat "$EMPTY.server.log" >&2; exit 2; }
  sleep 0.2
done
xvfb-run -a -s "-screen 0 1280x800x24" python3 "$REPO/hosts/linux/quiet_office.py" --selftest "http://127.0.0.1:$PORT/"

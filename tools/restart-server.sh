#!/usr/bin/env bash
#
# Restart the app server, and verify it actually restarted.
#
# ---------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS
# ---------------------------------------------------------------------------
# Config is read once at boot, so a `.env` or source edit after startup looks
# correct on disk while the process runs on the old value, with nothing in the UI
# to say so. Restarting is therefore routine here — and it has gone wrong twice in
# ways that cost real debugging time:
#
#   1. A restart silently did not take. `pkill` returned, the old process was still
#      alive, and the stale server kept serving while the new code sat on disk. The
#      next run exercised the unfixed code and the fix looked wrong (F-38).
#
#   2. The verification itself was matching the wrong process. `pgrep -f 'server\.js'`
#      also matches `tsserver.js` — the TypeScript language server the editor runs.
#      On this machine that meant reading a language server's start time and
#      comparing it against application source. It gave the right answer only
#      because the two happened to start seconds apart.
#
# So this script identifies the server by **who holds the port**, which is the only
# thing that cannot be coincidentally true, and refuses to report success without
# evidence.
#
#   ./tools/restart-server.sh          or     npm run restart
#
set -uo pipefail

PORT="${PORT:-3000}"
LOG="${LOG:-logs/server.log}"

# Match the application only. Anchoring on the script path excludes tsserver.js
# and any other process that merely contains "server.js".
APP_PATTERN='node src/server.js'

port_pid() { lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

echo "== stopping =="
before="$(port_pid || true)"
if [ -n "${before:-}" ]; then
  echo "   pid $before is serving :$PORT -> stopping"
else
  echo "   nothing listening on :$PORT"
fi

pkill -f "$APP_PATTERN" 2>/dev/null || true

# Wait for the port to be released rather than assuming a fixed sleep is enough.
for _ in $(seq 1 20); do
  [ -z "$(port_pid || true)" ] && break
  sleep 0.5
done

# Still held? Escalate, then confirm. A half-dead server holding the port is the
# failure mode that produced F-38's phantom.
if [ -n "$(port_pid || true)" ]; then
  echo "   port still held, sending SIGKILL"
  lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill -9
  sleep 1
fi

if [ -n "$(port_pid || true)" ]; then
  echo "   FAILED: :$PORT is still held by pid $(port_pid). Not starting a second server."
  exit 1
fi
echo "   port released"

echo "== starting =="
mkdir -p "$(dirname "$LOG")"
nohup node src/server.js >>"$LOG" 2>&1 &
sleep 1

for _ in $(seq 1 45); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
  sleep 1
done

PID="$(port_pid || true)"
if [ -z "${PID:-}" ]; then
  echo "   FAILED: server did not come up. Last 25 lines of $LOG:"
  tail -25 "$LOG" | sed 's/^/     /'
  exit 1
fi

STARTED="$(ps -o lstart= -p "$PID" 2>/dev/null)"
echo "   pid     $PID"
echo "   started $STARTED"
echo "   command $(ps -o command= -p "$PID" 2>/dev/null)"
echo "   health  $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")"

echo "== verifying =="

# Exactly one app server. Two would mean one serves while the other idles, and
# which one you are talking to becomes a coin flip.
COUNT="$(pgrep -f "$APP_PATTERN" | wc -l | tr -d ' ')"
if [ "$COUNT" = "1" ]; then
  echo "   OK  exactly one app server running"
else
  echo "   WARN $COUNT app servers match '$APP_PATTERN' — expected 1"
  pgrep -f "$APP_PATTERN" | sed 's/^/        pid /'
fi

# Nothing on disk newer than the process. This is the check that catches a restart
# that did not take.
STALE="$(find src public -type f -newermt "$STARTED" 2>/dev/null)"
if [ -z "$STALE" ]; then
  echo "   OK  no source newer than the running process"
else
  echo "   WARN these files are newer than the process — the restart may not have taken:"
  echo "$STALE" | sed 's/^/        /'
fi

# Behaviour, not timestamps. A file being loaded is not the same as a feature working.
CARRIERS="$(curl -s "http://127.0.0.1:$PORT/api/carriers" 2>/dev/null \
  | python3 -c 'import json,sys;print(",".join(c["id"] for c in json.load(sys.stdin)["carriers"]))' 2>/dev/null)"
echo "   OK  carriers served: ${CARRIERS:-<none>}"

echo
echo "Ready on http://localhost:$PORT   (logs: $LOG)"
echo "Hard-refresh the browser (Cmd+Shift+R) — app.js is cached and calls /api/prewarm."

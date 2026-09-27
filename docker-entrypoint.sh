#!/usr/bin/env bash
set -euo pipefail

# Runs the app either headless, or headed inside a virtual X display.
#
# Headed-under-Xvfb is the stronger anti-detection posture: a real windowed
# Chrome differs from new-headless in ways detection vendors actively probe
# (window.outerHeight vs innerHeight, screen dimensions, whether the compositor
# reports a real display). Xvfb gives us a display without a GPU or a monitor.
#
# The tradeoff is roughly 80-150MB of extra RSS and a slower start, so it is
# opt-in via HEADLESS=false rather than the default.

if [[ "${HEADLESS:-true}" == "false" ]]; then
  echo "[entrypoint] HEADLESS=false -> starting under Xvfb virtual display"
  # -a picks a free display number, avoiding a collision if a stale lock exists.
  # 1920x1080x24 is an unremarkable consumer resolution; odd sizes stand out.
  exec xvfb-run -a --server-args="-screen 0 1920x1080x24 -nolisten tcp" "$@"
fi

echo "[entrypoint] running headless"
exec "$@"

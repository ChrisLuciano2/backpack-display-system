#!/bin/bash
# run-vlc.sh: starts VLC for Video Mode. Used by video-mode.service on the Pi
# and by the virtual Pi (SIM=1). The same script runs in both places.
#
# Environment:
#   VLC_PASSWORD  web interface password (default: backpack, replaced by a generated secret in the security step)
#   SIM=1         headless: no screen, no sound device (virtual Pi)

set -e

# When run as a systemd service the Wayland socket variable may be missing.
if [ -z "$WAYLAND_DISPLAY" ]; then
  _runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  for _d in wayland-1 wayland-0; do
    if [ -S "$_runtime/$_d" ]; then export WAYLAND_DISPLAY="$_d"; break; fi
  done
fi

OUTPUT_ARGS=(--fullscreen --mouse-hide-timeout=100)
if [ "$SIM" = "1" ]; then
  OUTPUT_ARGS=(--vout dummy --aout dummy)
fi

# exec so the service's main process is VLC itself and stop signals reach it.
exec vlc \
  --intf dummy \
  --extraintf http \
  --http-password "${VLC_PASSWORD:-backpack}" \
  --http-port 8080 \
  "${OUTPUT_ARGS[@]}" \
  --no-video-title-show \
  --quiet

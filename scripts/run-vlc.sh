#!/bin/bash
# run-vlc.sh: starts VLC for Video Mode. Used by video-mode.service on the Pi
# and by the virtual Pi (SIM=1). The same script runs in both places.
#
# Environment:
#   VLC_PASSWORD  web interface password (the installer writes a random one to
#                 ~/.config/backpack/secrets.env; the default only exists for old setups)
#   SIM=1         headless: no screen, no sound device (virtual Pi)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=session-prep.sh
. "$HERE/session-prep.sh"

OUTPUT_ARGS=(--fullscreen --mouse-hide-timeout=100)
if [ "$SIM" = "1" ]; then
  OUTPUT_ARGS=(--vout dummy --aout dummy)
fi

# VLC's web interface is only used by the server on this same Pi, so keep it off
# the network. Only added when this VLC knows the option, so an unexpected version
# can never stop VLC from starting.
HOST_ARGS=()
if vlc --help --advanced 2>/dev/null | grep -q -e '--http-host'; then
  HOST_ARGS=(--http-host 127.0.0.1)
fi

# exec so the service's main process is VLC itself and stop signals reach it.
exec vlc \
  --intf dummy \
  --extraintf http \
  --http-password "${VLC_PASSWORD:-backpack}" \
  --http-port 8080 \
  "${HOST_ARGS[@]}" \
  "${OUTPUT_ARGS[@]}" \
  --no-video-title-show \
  --quiet

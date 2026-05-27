#!/bin/bash
# start.sh — Launch VLC + BT server on the Pi
#
# Run manually:   ./start.sh
# Managed by systemd: systemctl --user start backpack

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║      Backpack Display System — Startup       ║"
echo "╚══════════════════════════════════════════════╝"
echo "Project: $PROJECT_DIR"
echo ""

# ── Wayland display ──────────────────────────────────────────────────────────
# When run as a systemd service the WAYLAND_DISPLAY env var may not be
# inherited automatically. Detect the live socket instead.
if [ -z "$WAYLAND_DISPLAY" ]; then
  _runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  for _d in wayland-1 wayland-0; do
    if [ -S "$_runtime/$_d" ]; then
      export WAYLAND_DISPLAY="$_d"
      break
    fi
  done
fi

if [ -n "$WAYLAND_DISPLAY" ]; then
  echo "[display] WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
else
  echo "[display] WARNING: no Wayland socket found — video output may fail"
fi

# ── Audio ────────────────────────────────────────────────────────────────────
# WirePlumber sometimes defaults to "Dummy Output" after a fresh boot.
# Detect this and restart WirePlumber before starting VLC so audio works.
_audio_ok=false
for _attempt in 1 2 3; do
  if wpctl status 2>/dev/null | grep -qF "Dummy Output"; then
    echo "[audio] Dummy Output detected (attempt $_attempt/3) — restarting WirePlumber..."
    systemctl --user restart wireplumber 2>/dev/null || true
    sleep 3
  else
    _audio_ok=true
    break
  fi
done

if [ "$_audio_ok" = true ]; then
  wpctl set-volume @DEFAULT_AUDIO_SINK@ 1.0 2>/dev/null || true
  echo "[audio] Volume set to 100%"
else
  echo "[audio] WARNING: audio sink still shows Dummy Output — continuing anyway"
fi

# ── VLC ──────────────────────────────────────────────────────────────────────
# Kill any leftover instance from a previous run
pkill vlc 2>/dev/null && echo "[vlc] Killed existing VLC instance" || true
sleep 1

vlc \
  --intf dummy \
  --extraintf http \
  --http-password backpack \
  --http-port 8080 \
  --fullscreen \
  --no-video-title-show \
  --avcodec-hw=any \
  --quiet &

VLC_PID=$!
echo "[vlc] Started (PID $VLC_PID)"

# Give VLC time to open its HTTP socket before Node.js tries to connect
sleep 2

# ── Node.js BT + upload server ───────────────────────────────────────────────
echo "[server] Starting Node.js server..."
node "$PROJECT_DIR/server/index.js"

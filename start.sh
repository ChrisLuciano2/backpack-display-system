#!/bin/bash
# start.sh — Launch VLC then the BT server on the Pi
#
# Usage:
#   chmod +x start.sh
#   ./start.sh
#
# For autostart on boot, add to /etc/rc.local (before "exit 0"):
#   su pi -c '/home/pi/backpack-display-system/start.sh >> /home/pi/bt-server.log 2>&1 &'

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Backpack Display System ==="
echo "Project dir: $PROJECT_DIR"

# Kill any leftover VLC instance
pkill vlc 2>/dev/null && echo "[vlc] Killed existing VLC" || true
sleep 1

# Start VLC with HTTP API on port 8080, fullscreen, no OSD title
# --avcodec-hw=any  → use Pi 5 hardware H.264/H.265 decoder (V4L2 M2M)
#                     without this VLC falls back to CPU-only decode (~10 fps)
# The display is already rotated 90° via raspi-config / display settings
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

# Brief pause so VLC can open its HTTP socket before Node tries to ping it
sleep 2

# Start the Node.js BT server (handles its own VLC-ready retry loop)
echo "[server] Starting Node.js BT server..."
node "$PROJECT_DIR/server/index.js"

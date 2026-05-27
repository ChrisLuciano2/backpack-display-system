#!/bin/bash
# install-service.sh — one-shot setup for backpack autostart on Pi OS Bookworm
#
# Run once:  bash install-service.sh
# Uninstall: systemctl --user disable --now backpack

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="backpack"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Backpack Display — Autostart Installer     ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────

if [ ! -f "$SCRIPT_DIR/start.sh" ]; then
  echo "ERROR: start.sh not found in $SCRIPT_DIR"
  echo "Run this script from the backpack-display-system folder."
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/backpack.service" ]; then
  echo "ERROR: backpack.service not found in $SCRIPT_DIR"
  exit 1
fi

if [ ! -d "$SCRIPT_DIR/server" ]; then
  echo "ERROR: server/ directory not found — wrong folder?"
  exit 1
fi

echo "✓ All files found"

# ── Install ───────────────────────────────────────────────────────────────────

mkdir -p "$SERVICE_DIR"

cp "$SCRIPT_DIR/backpack.service" "$SERVICE_DIR/$SERVICE_NAME.service"
echo "✓ Service file → $SERVICE_DIR/$SERVICE_NAME.service"

chmod +x "$SCRIPT_DIR/start.sh"
echo "✓ start.sh is executable"

# Reload systemd to pick up the new service file
systemctl --user daemon-reload
echo "✓ systemd reloaded"

# Enable so it starts automatically on every boot
systemctl --user enable "$SERVICE_NAME"
echo "✓ Service enabled for autostart"

# Enable linger: keeps user services alive even before the user has
# interactively logged in (good practice for headless/kiosk setups)
loginctl enable-linger "$USER" 2>/dev/null || true
echo "✓ Linger enabled for $USER"

# ── Test run ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Test: stopping any existing server and starting via systemd ==="
echo "(This simulates exactly what happens on boot)"
echo ""

# Stop manually-started server if running (so ports are free)
pkill node 2>/dev/null && echo "[test] Stopped existing node process" || true
pkill vlc  2>/dev/null && echo "[test] Stopped existing VLC" || true
sleep 2

systemctl --user start "$SERVICE_NAME"
echo "Service started — waiting 8 s for it to initialise..."
sleep 8

echo ""
echo "=== Service status ==="
systemctl --user status "$SERVICE_NAME" --no-pager -l

echo ""
echo "=== Last 20 lines of ~/backpack.log ==="
tail -n 20 "$HOME/backpack.log" 2>/dev/null || echo "(log file not created yet)"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║              Install complete!               ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  systemctl --user status backpack    # is it running?"
echo "  systemctl --user restart backpack   # restart"
echo "  systemctl --user stop backpack      # stop"
echo "  systemctl --user disable backpack   # remove autostart"
echo "  tail -f ~/backpack.log              # live log output"
echo ""
echo "NEXT STEP — reboot the Pi and confirm it starts automatically:"
echo "  sudo reboot"
echo "  # wait ~30 s, then open the phone app and check it connects"

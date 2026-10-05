#!/bin/bash
# session-prep.sh: sourced (not run) by run-vlc.sh and run-retroarch.sh.
# Gets the Pi's desktop session ready before either program starts, the same things
# the old start.sh did: find the Wayland socket, keep the desktop hidden behind a
# black background, and fix the "Dummy Output" audio problem after a fresh boot.
#
# Skipped completely in the virtual Pi (SIM=1).

if [ "$SIM" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# ── Wayland display ──────────────────────────────────────────────────────────
# As a service, the compositor may still be starting. Wait for its socket (up to 40 s).
if [ -z "$WAYLAND_DISPLAY" ]; then
  _runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  for _try in $(seq 1 80); do
    for _d in wayland-1 wayland-0; do
      if [ -S "$_runtime/$_d" ]; then export WAYLAND_DISPLAY="$_d"; break 2; fi
    done
    sleep 0.5
  done
fi
if [ -n "$WAYLAND_DISPLAY" ]; then
  echo "[prep] WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
else
  echo "[prep] WARNING: no Wayland socket found, picture may fail"
fi

# ── Black background so the desktop never shows between clips or games ──────
if command -v swaybg >/dev/null 2>&1; then
  pkill swaybg 2>/dev/null || true
  swaybg -c 000000 >/dev/null 2>&1 &
fi

# ── Audio: WirePlumber sometimes picks "Dummy Output" after a fresh boot ────
if command -v wpctl >/dev/null 2>&1; then
  for _attempt in 1 2 3; do
    if wpctl status 2>/dev/null | grep -qF "Dummy Output"; then
      echo "[prep] Dummy Output detected (attempt $_attempt of 3), restarting WirePlumber"
      systemctl --user restart wireplumber 2>/dev/null || true
      sleep 3
    else
      break
    fi
  done
  wpctl set-volume @DEFAULT_AUDIO_SINK@ 1.0 2>/dev/null || true
fi

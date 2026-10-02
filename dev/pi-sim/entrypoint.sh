#!/bin/bash
# Starts VLC (headless, real web interface) and then, for the scenarios that
# need it, the real server/index.js. The server code is mounted at /app.
# What runs after startup is set by $1:
#   server   (default) run VLC + server and stay up
#   scenario <name>    run VLC (+ server, for scenarios that need it), run one
#                       scenario, exit with its result
#
# testtarget and gamemode drive the fake systemd units and RetroArch directly,
# so the real server must NOT be running for them — its own mode manager would
# poll and "heal" the very state those scenarios are deliberately changing,
# two controllers fighting over one steering wheel. race and protocol drive
# the phone protocol, so they need the real server up.
set -e

MODE="${1:-server}"
SCENARIO="${2:-}"
case "$SCENARIO" in
  testtarget|gamemode) NEEDS_SERVER=0 ;;
  *)                   NEEDS_SERVER=1 ;;
esac

# Test media: short clips with spaces in the names (the filename bug that
# cost a day on the real Pi) plus one long clip.
if [ ! -f /media/.generated ]; then
  echo "[sim] generating test media"
  gen() { # name seconds
    ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=640x360:rate=25" -f lavfi -i "sine=frequency=440" \
      -t "$2" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "/media/$1"
  }
  gen "short one.mp4" 4
  gen "short two.mp4" 4
  gen "short three.mp4" 4
  gen "Alice's Wonderland.mp4" 20
  gen "long clip.mp4" 60
  touch /media/.generated
fi

# Fixture game library. Filler bytes only, not real games. GBA and PS1 have no
# core or BIOS on purpose, so the "not installed" and "needs BIOS" states can be tested.
if [ ! -f "$HOME/.fixtures-done" ]; then
  mkdir -p "$HOME/roms/nes" "$HOME/roms/snes" "$HOME/roms/gba" "$HOME/roms/ps1"            "$HOME/cores" "$HOME/states" "$HOME/.config/backpack" "$HOME/.local/state/backpack" "$HOME/bios"
  for f in "nes/Demo Game A.nes" "nes/Demo Game B.nes" "snes/Demo Snes.sfc" "gba/Demo Gba.gba" "ps1/Demo Disc.cue"; do
    printf 'filler, not a real game' > "$HOME/roms/$f"
  done
  touch "$HOME/cores/nestopia_libretro.so" "$HOME/cores/snes9x_libretro.so" "$HOME/cores/pcsx_rearmed_libretro.so"
  touch "$HOME/.fixtures-done"
fi

if [ -f /app/scripts/run-vlc.sh ]; then
  echo "[sim] starting VLC through the video-mode unit"
  systemctl --user start video-mode.service
else
  echo "[sim] no run-vlc.sh in /app (original code): starting VLC directly"
  cvlc --intf dummy --extraintf http --http-password backpack --http-port 8080        --vout dummy --aout dummy --no-video-title-show --quiet >/tmp/vlc.log 2>&1 &
fi

for i in $(seq 1 30); do
  if curl -s -u :backpack http://127.0.0.1:8080/requests/status.json >/dev/null 2>&1; then
    echo "[sim] VLC web interface is up"; break
  fi
  sleep 0.5
done

SERVER_PID=""
if [ "$NEEDS_SERVER" = "1" ]; then
  echo "[sim] starting server from /app/server/index.js"
  node /app/server/index.js >/tmp/server.log 2>&1 &
  SERVER_PID=$!

  for i in $(seq 1 30); do
    # Read the log instead of connecting: a probe connection would count as a phone.
    if grep -q "\[bt\] Listening" /tmp/server.log 2>/dev/null; then echo "[sim] fake Bluetooth (TCP :9000) is up"; break; fi
    sleep 0.5
  done

  node /opt/sim/dashboard.js >/tmp/dashboard.log 2>&1 &
else
  echo "[sim] skipping the real server for this scenario ($SCENARIO drives the units directly)"
fi

if [ "$MODE" = "scenario" ]; then
  set +e
  node "/opt/sim/scenarios/$SCENARIO.js"
  RC=$?
  if [ -f /tmp/server.log ]; then
    echo "----- server log (last 25 lines) -----"
    tail -n 25 /tmp/server.log
  fi
  [ -n "$SERVER_PID" ] && kill $SERVER_PID 2>/dev/null
  exit $RC
fi

echo "[sim] ready. Fake phone: docker exec -it <container> node /opt/sim/phone.js '{\"action\":\"list\"}'"
if [ -n "$SERVER_PID" ]; then wait $SERVER_PID; else sleep infinity; fi

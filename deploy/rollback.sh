#!/bin/bash
# deploy/rollback.sh: go back to the old single service setup (start.sh).
#   bash deploy/rollback.sh
# Afterwards, to also go back to the old code:  git checkout video-only-v1

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
CFG_DIR="$HOME/.config/backpack"

say() { echo "[rollback] $*"; }

systemctl --user stop backpack.service game-mode.service video-mode.service 2>/dev/null
systemctl --user disable backpack.service video-mode.service game-mode.service 2>/dev/null
pkill -x retroarch 2>/dev/null
pkill -x vlc 2>/dev/null
rm -f "$UNIT_DIR/video-mode.service" "$UNIT_DIR/game-mode.service"

# Put back the oldest backup of the original backpack.service, if there is one.
oldest="$(ls -d "$CFG_DIR"/backup-* 2>/dev/null | head -n 1)"
if [ -n "$oldest" ] && [ -f "$oldest/backpack.service" ]; then
  cp "$oldest/backpack.service" "$UNIT_DIR/backpack.service"
  say "restored the original backpack.service from $oldest"
else
  cp "$REPO/backpack.service" "$UNIT_DIR/backpack.service"
  say "restored backpack.service from the repo copy"
fi

systemctl --user daemon-reload
systemctl --user enable backpack.service
systemctl --user start backpack.service
sleep 5
say "backpack.service is $(systemctl --user is-active backpack.service)"

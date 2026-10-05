#!/bin/bash
# deploy/install.sh: installs the Video Mode and Game Mode services on the Pi.
# Safe to run again. Run it from the repo folder on the Pi:
#   bash deploy/install.sh
# Undo it with:  bash deploy/rollback.sh

set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
CFG_DIR="$HOME/.config/backpack"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$CFG_DIR/backup-$STAMP"
NODE="$(command -v node || true)"

say() { echo "[install] $*"; }

[ -n "$NODE" ] || { echo "ERROR: node is not installed or not on PATH"; exit 1; }
command -v vlc >/dev/null 2>&1 || { echo "ERROR: vlc is not installed"; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemctl not found"; exit 1; }
command -v retroarch >/dev/null 2>&1 || say "WARNING: retroarch is not installed yet (sudo apt install retroarch). Video Mode will still work."

say "repo:  $REPO"
say "node:  $NODE"

mkdir -p "$UNIT_DIR" "$CFG_DIR" "$BACKUP"

# ── Back up what is there now, so rollback can restore it ───────────────────
for f in backpack.service video-mode.service game-mode.service; do
  [ -f "$UNIT_DIR/$f" ] && cp "$UNIT_DIR/$f" "$BACKUP/$f" || true
done
[ -f "$CFG_DIR/retroarch.cfg" ] && cp "$CFG_DIR/retroarch.cfg" "$BACKUP/retroarch.cfg" || true
say "backup: $BACKUP"

# ── Folders for games, saves and BIOS ───────────────────────────────────────
mkdir -p "$HOME/roms/nes" "$HOME/roms/snes" "$HOME/roms/genesis" "$HOME/roms/gba" "$HOME/roms/ps1" \
         "$HOME/saves" "$HOME/states" "$HOME/bios" "$HOME/cores" "$HOME/.local/state/backpack"

# ── Make the installed emulator cores visible to the server ────────────────
n=0
for core in /usr/lib/*/libretro/*_libretro.so /usr/lib/libretro/*_libretro.so; do
  [ -e "$core" ] || continue
  ln -sf "$core" "$HOME/cores/$(basename "$core")"
  n=$((n+1))
done
say "linked $n emulator core(s) into ~/cores"

# ── A private random password for VLC's web interface ──────────────────────
if [ ! -f "$CFG_DIR/secrets.env" ]; then
  pw="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  umask 077
  printf 'VLC_PASSWORD=%s\n' "$pw" > "$CFG_DIR/secrets.env"
  chmod 600 "$CFG_DIR/secrets.env"
  say "created $CFG_DIR/secrets.env (random VLC password, private to you)"
else
  say "kept the existing $CFG_DIR/secrets.env"
fi

# ── RetroArch settings (guest safe). Never overwrites your own edits. ──────
if [ ! -f "$CFG_DIR/retroarch.cfg" ]; then
  cp "$REPO/config/retroarch.cfg" "$CFG_DIR/retroarch.cfg"
  say "installed RetroArch settings: $CFG_DIR/retroarch.cfg"
else
  say "kept your existing $CFG_DIR/retroarch.cfg (new defaults are in $REPO/config/retroarch.cfg)"
fi

# ── Stop the old setup, whichever way it was started ───────────────────────
say "stopping the old server and VLC"
systemctl --user stop backpack.service 2>/dev/null || true
pkill -f "node .*server/index.js" 2>/dev/null || true
pkill -x vlc 2>/dev/null || true
sleep 1

# ── Install the three services ─────────────────────────────────────────────
for f in backpack.service video-mode.service game-mode.service; do
  sed -e "s#@REPO@#$REPO#g" -e "s#@NODE@#$NODE#g" "$REPO/deploy/$f" > "$UNIT_DIR/$f"
done
chmod +x "$REPO"/scripts/*.sh
systemctl --user daemon-reload
systemctl --user enable backpack.service video-mode.service
systemctl --user disable game-mode.service 2>/dev/null || true
loginctl enable-linger "$USER" 2>/dev/null || true

# ── Start Video Mode, then the server ──────────────────────────────────────
systemctl --user start video-mode.service
sleep 3
systemctl --user start backpack.service
sleep 8

echo
say "status"
for u in video-mode backpack game-mode; do
  printf '  %-12s %s\n' "$u" "$(systemctl --user is-active $u.service)"
done
echo
say "log: tail -n 30 ~/backpack.log   (look for: [mode] Ready - current mode: video)"
say "undo: bash $REPO/deploy/rollback.sh"

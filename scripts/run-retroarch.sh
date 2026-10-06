#!/bin/bash
# run-retroarch.sh: starts RetroArch for Game Mode. Used by game-mode.service on
# the Pi and by the virtual Pi (with the fake RetroArch). The same script runs in both.
#
# What to launch is read from a small file the server writes just before it
# starts or restarts this unit:
#   ~/.local/state/backpack/launch.env
#     CORE=/path/to/core_libretro.so
#     ROM=/path/to/game.rom
# Both empty (or no file) means "menu only": RetroArch starts with no content.
# The file is parsed line by line, never sourced, so its contents cannot run as code.
#
# Environment:
#   RETROARCH_BIN         program to run (default: retroarch)
#   RETROARCH_CONFIG      config file (default: ~/.config/backpack/retroarch.cfg)
#   BACKPACK_STATE_DIR    where launch.env lives

set -e

STATE_DIR="${BACKPACK_STATE_DIR:-$HOME/.local/state/backpack}"
ENV_FILE="$STATE_DIR/launch.env"
CONFIG="${RETROARCH_CONFIG:-$HOME/.config/backpack/retroarch.cfg}"
BIN="${RETROARCH_BIN:-retroarch}"

CORE=""
ROM=""
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      CORE) CORE="$value" ;;
      ROM)  ROM="$value" ;;
    esac
  done < "$ENV_FILE"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=session-prep.sh
. "$HERE/session-prep.sh"

# Rebuild the game lists so newly copied games show up on their own.
if command -v python3 >/dev/null 2>&1; then
  python3 "$HERE/../tools/make_playlists.py" >/dev/null 2>&1 || true
fi

ARGS=(--fullscreen)
if [ -f "$CONFIG" ]; then ARGS+=(--config "$CONFIG"); fi
if [ -n "$CORE" ] && [ -n "$ROM" ]; then
  ARGS+=(-L "$CORE" "$ROM")
fi

exec "$BIN" "${ARGS[@]}"

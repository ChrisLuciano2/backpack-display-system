#!/usr/bin/env python3
"""Builds RetroArch game lists (playlists) from the games folder, so a guest picks a game
by name from a list instead of browsing the Pi's folders.

For every system in server/systems.json it scans ~/roms/<folder>, finds that system's
emulator core, and writes ~/.config/retroarch/playlists/<System name>.lpl. A system with no
games or no installed core gets no list. Safe to run again at any time, and it runs every
time Game Mode starts, so newly copied games appear on their own.

Usage: python3 make_playlists.py [--roms DIR] [--out DIR]
"""
import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEMS = os.path.join(HERE, "..", "server", "systems.json")
MARKER = "backpack-generated"


def find_core(core_file, cores_dir):
    candidates = [os.path.join(cores_dir, core_file)]
    candidates += glob.glob(f"/usr/lib/*/libretro/{core_file}")
    candidates += glob.glob(f"/usr/lib/libretro/{core_file}")
    for c in candidates:
        if os.path.exists(c):
            return os.path.realpath(c)
    return None


def clean_label(name):
    """Drops dump tags like (USA), (Rev 1), [!] so guests see the game's plain title."""
    import re
    cleaned = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", name).strip(" -_")
    return cleaned or name


def scan(roms_dir, folders, extensions, max_depth=2):
    exts = {e.lower() for e in extensions}
    found = []
    for folder in folders:
        root = os.path.join(roms_dir, folder)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            depth = os.path.relpath(dirpath, root).count(os.sep) + (0 if dirpath == root else 1)
            if depth >= max_depth:
                dirnames[:] = []
            for name in filenames:
                if name.startswith("."):
                    continue
                if os.path.splitext(name)[1].lower() in exts:
                    found.append(os.path.join(dirpath, name))
    return sorted(found, key=lambda p: os.path.basename(p).lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roms", default=os.path.expanduser("~/roms"))
    ap.add_argument("--cores", default=os.path.expanduser("~/cores"))
    ap.add_argument("--out", default=os.path.expanduser("~/.config/retroarch/playlists"))
    args = ap.parse_args()

    with open(SYSTEMS, encoding="utf-8") as f:
        systems = {k: v for k, v in json.load(f).items() if not k.startswith("_")}

    os.makedirs(args.out, exist_ok=True)
    wanted = set()
    for sid, sysdef in systems.items():
        core = find_core(sysdef["core"], args.cores)
        games = scan(args.roms, sysdef["dirs"], sysdef["extensions"])
        if not core or not games:
            print(f"  {sysdef['name']}: skipped ({'no core installed' if not core else 'no games'})")
            continue
        items = [{
            "path": g,
            "label": clean_label(os.path.splitext(os.path.basename(g))[0]),
            "core_path": core,
            "core_name": sysdef["name"],
            "crc32": "00000000|crc",
            "db_name": sysdef["name"] + ".lpl",
        } for g in games]
        playlist = {
            "version": "1.5",
            "default_core_path": core,
            "default_core_name": sysdef["name"],
            "label_display_mode": 0,
            "right_thumbnail_mode": 0,
            "left_thumbnail_mode": 0,
            "thumbnail_match_mode": 0,
            "sort_mode": 0,
            "items": items,
        }
        fname = sysdef["name"].replace("/", "-") + ".lpl"
        wanted.add(fname)
        with open(os.path.join(args.out, fname), "w", encoding="utf-8") as f:
            json.dump(playlist, f, indent=2)
        print(f"  {sysdef['name']}: {len(items)} game(s)")

    # Remove lists we made earlier for systems that no longer have games.
    for sysdef in systems.values():
        fname = sysdef["name"].replace("/", "-") + ".lpl"
        path = os.path.join(args.out, fname)
        if fname not in wanted and os.path.exists(path):
            os.remove(path)
            print(f"  removed stale list {fname}")


if __name__ == "__main__":
    sys.exit(main())

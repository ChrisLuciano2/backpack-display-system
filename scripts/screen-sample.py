#!/usr/bin/env python3
"""Samples the Pi's screen about five times a second and prints a line whenever the picture
changes noticeably: time, average color, and how bright it is. Used to measure what a person
would actually see (how long the screen is black or blank during a mode switch).

Run on the Pi from the desktop session:  python3 screen-sample.py [seconds]
Needs `grim` (the screenshot tool for this desktop).
"""
import os
import subprocess
import sys
import time

os.environ.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())
if "WAYLAND_DISPLAY" not in os.environ:
    for d in ("wayland-1", "wayland-0"):
        if os.path.exists(os.path.join(os.environ["XDG_RUNTIME_DIR"], d)):
            os.environ["WAYLAND_DISPLAY"] = d
            break

duration = float(sys.argv[1]) if len(sys.argv) > 1 else 30
t0 = time.time()
last = None


def clock():
    t = time.time()
    return time.strftime('%H:%M:%S', time.localtime(t)) + '.%03d' % int((t % 1) * 1000)


def sample():
    out = subprocess.run(["grim", "-s", "0.03", "-t", "ppm", "-"], capture_output=True, timeout=5).stdout
    # PPM: "P6\n<w> <h>\n255\n" then raw RGB bytes
    parts = out.split(b"\n", 3)
    data = parts[3]
    n = len(data) // 3
    r = sum(data[0::3]) / n
    g = sum(data[1::3]) / n
    b = sum(data[2::3]) / n
    return r, g, b


while time.time() - t0 < duration:
    try:
        r, g, b = sample()
    except Exception as e:
        print(f"{clock()}  (could not sample: {e})", flush=True)
        time.sleep(0.3)
        continue
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if last is None or abs(r - last[0]) + abs(g - last[1]) + abs(b - last[2]) > 18:
        kind = "BLACK" if lum < 6 else "picture"
        print(f"{clock()}  {kind:8} rgb=({r:3.0f},{g:3.0f},{b:3.0f}) brightness={lum:3.0f}", flush=True)
        last = (r, g, b)
    time.sleep(0.12)

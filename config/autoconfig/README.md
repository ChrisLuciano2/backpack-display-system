# Controller profiles

RetroArch needs a profile to know which button is which. Debian does not ship them, so
they are kept here and `deploy/install.sh` copies them to `~/.config/retroarch/autoconfig/`.

- `8BitDo_Ultimate_Wireless_24G.cfg` is the official libretro profile for USB id 2dc8:3106
  (8BitDo Ultimate 2.4G dongle, X-input style), from
  https://github.com/libretro/retroarch-joypad-autoconfig (MIT licensed), with the device name
  changed to match what the Pi reports: "8BitDo Ultimate Wireless / Pro 2 Wired Controller".
  Tested on the Pi on 2026-10-05: both controllers were configured as port 1 and port 2.

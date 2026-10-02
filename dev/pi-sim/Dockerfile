# Virtual Pi for testing the Backpack server without the real Pi.
# Debian Bookworm (same base as Raspberry Pi OS) + real VLC + Node 22.
# Bluetooth is replaced by a TCP stub, the HDMI screen by a fake wlr-randr.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends vlc-bin vlc-plugin-base ffmpeg netcat-openbsd procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /media && chown node:node /media

COPY bt-stub /opt/bt-stub
COPY fake-bin/ /usr/local/bin/
COPY scenarios /opt/sim/scenarios
COPY phone.js /opt/sim/phone.js
COPY dashboard.js /opt/sim/dashboard.js
COPY retroarch-sim.js /opt/sim/retroarch-sim.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/wlr-randr /usr/local/bin/systemctl /usr/local/bin/retroarch

USER node
ENV NODE_PATH=/opt/bt-stub/modules \
    MEDIA_DIR=/media \
    USER=node \
    HOME=/home/node \
    SIM=1 \
    RETROARCH_BIN=retroarch
ENTRYPOINT ["/entrypoint.sh"]

// server/config.js
// Central configuration for the Backpack Display BT Server
// Edit these values if your setup differs

module.exports = {
  // ── Media ──────────────────────────────────────────────────────────────────
  // Directory on the Pi's microSD where video files live
  MEDIA_DIR: process.env.MEDIA_DIR || `/home/${process.env.USER || 'chrisl'}/media`,

  // File extensions considered playable
  MEDIA_EXTS: ['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm'],

  // ── VLC HTTP API ───────────────────────────────────────────────────────────
  // VLC must be launched with:
  //   vlc --intf dummy --extraintf http --http-password backpack --http-port 8080
  VLC_HOST: '127.0.0.1',
  VLC_PORT: 8080,
  VLC_PASSWORD: process.env.VLC_PASSWORD || 'backpack',

  // ── Bluetooth ──────────────────────────────────────────────────────────────
  // Standard SPP (Serial Port Profile) UUID — must match React Native client
  BT_UUID: '00001101-0000-1000-8000-00805F9B34FB',
  BT_CHANNEL: 1,

  // How often (ms) to broadcast status to phone while media is playing
  STATUS_INTERVAL_MS: 2000,
};

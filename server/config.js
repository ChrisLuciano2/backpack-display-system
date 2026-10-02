// server/config.js
// Central configuration for the Backpack Display BT Server
// Edit these values if your setup differs

module.exports = {
  // ── Media ──────────────────────────────────────────────────────────────────
  // Directory on the Pi's microSD where video files live
  MEDIA_DIR: process.env.MEDIA_DIR || `/home/${process.env.USER || 'chrisl'}/media`,

  // File extensions considered playable, grouped by category
  MEDIA_EXTS: ['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.gif', '.jpg', '.jpeg', '.png'],

  // Extensions that are images/GIFs (displayed via VLC image player)
  IMAGE_EXTS: ['.gif', '.jpg', '.jpeg', '.png'],

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

  // ── Upload HTTP server ─────────────────────────────────────────────────────
  // Phone uploads files to Pi over WiFi on this port
  UPLOAD_PORT: process.env.UPLOAD_PORT || 3001,

  // ── Game Mode ──────────────────────────────────────────────────────────────
  // Where games, cores, BIOS files and save states live, and where the server
  // leaves its own small state files (launch.env, queue.json).
  ROMS_DIR: process.env.ROMS_DIR || `/home/${process.env.USER || 'chrisl'}/roms`,
  CORES_DIR: process.env.CORES_DIR || `/home/${process.env.USER || 'chrisl'}/cores`,
  BIOS_DIR: process.env.BIOS_DIR || `/home/${process.env.USER || 'chrisl'}/bios`,
  STATES_DIR: process.env.STATES_DIR || `/home/${process.env.USER || 'chrisl'}/states`,
  STATE_DIR: process.env.BACKPACK_STATE_DIR || `/home/${process.env.USER || 'chrisl'}/.local/state/backpack`,

  // RetroArch network command port (network_cmd_enable, verify in Phase 0).
  RETROARCH_UDP_PORT: Number(process.env.RETROARCH_UDP_PORT || 55355),
};

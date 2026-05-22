// server/index.js
// Backpack Display System — Bluetooth SPP Server
//
// Architecture:
//   Phone (React Native) ──BT Classic SPP──▶ This server ──HTTP──▶ VLC
//
// Protocol: newline-delimited JSON, both directions
//
// Phone → Pi (commands):
//   { "action": "play",   "file": "video.mp4" }
//   { "action": "pause"  }
//   { "action": "resume" }
//   { "action": "stop"   }
//   { "action": "next"   }
//   { "action": "prev"   }
//   { "action": "volume", "level": 75 }       // 0-100
//   { "action": "seek",   "seconds": 120 }
//   { "action": "list"   }
//
// Pi → Phone (status):
//   { "status": "playing", "file": "video.mp4", "pos": 42, "duration": 3600, "volume": 75 }
//   { "files": ["a.mp4", "b.mp4"] }           // response to "list"
//   { "error": "File not found: ..." }

'use strict';

const { BluetoothSerialPortServer } = require('bluetooth-serial-port');
const vlc   = require('./vlc');
const media = require('./media');
const { startUploadServer } = require('./upload');
const { BT_UUID, BT_CHANNEL, STATUS_INTERVAL_MS } = require('./config');

// ── State ─────────────────────────────────────────────────────────────────────

let server         = null;   // BluetoothSerialPortServer instance (recreated on each listen)
let connected      = false;  // Whether a phone client is currently connected
let receiveBuffer  = '';     // Incomplete JSON line accumulator
let statusTimer    = null;   // Periodic status broadcast interval

// ── Outbound: Send JSON to phone ──────────────────────────────────────────────

function send(obj) {
  if (!connected || !server) return;
  const line = JSON.stringify(obj) + '\n';
  server.write(Buffer.from(line, 'utf8'), (err) => {
    if (err) console.error('[bt] Write error:', err.message);
  });
}

// ── Periodic status broadcast ─────────────────────────────────────────────────

function startStatusBroadcast() {
  if (statusTimer) return;
  statusTimer = setInterval(async () => {
    if (!connected) return;
    try {
      const st = await vlc.buildStatus(false);
      // Only push unsolicited updates while something is actively playing
      if (st.status === 'playing') {
        send(st);
      }
    } catch {
      // VLC may be momentarily unreachable — ignore, next tick will retry
    }
  }, STATUS_INTERVAL_MS);
}

function stopStatusBroadcast() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

// ── Inbound: Command dispatcher ───────────────────────────────────────────────

async function dispatch(cmd) {
  const { action } = cmd;
  console.log('[cmd] ←', JSON.stringify(cmd));

  try {
    switch (action) {

      // ── Playback control ─────────────────────────────────────────────────
      case 'play': {
        if (cmd.file) {
          const fullPath = media.resolveFile(cmd.file);
          if (!fullPath) {
            send({ error: 'File not found: ' + cmd.file });
            return;
          }
          await vlc.playFile(fullPath);
        } else {
          // Resume current item without specifying a file
          await vlc.resume();
        }
        break;
      }

      case 'pause':
        await vlc.pause();
        break;

      case 'resume':
        await vlc.resume();
        break;

      case 'stop':
        await vlc.stop();
        break;

      case 'next':
        await vlc.next();
        break;

      case 'prev':
        await vlc.prev();
        break;

      // ── Volume ────────────────────────────────────────────────────────────
      case 'volume': {
        const level = Number(cmd.level);
        if (isNaN(level)) {
          send({ error: 'volume requires a numeric "level" (0-100)' });
          return;
        }
        await vlc.setVolume(level);
        break;
      }

      // ── Seek ──────────────────────────────────────────────────────────────
      case 'seek': {
        const seconds = Number(cmd.seconds);
        if (isNaN(seconds)) {
          send({ error: 'seek requires a numeric "seconds" value' });
          return;
        }
        await vlc.seek(seconds);
        break;
      }

      // ── Display rotation ──────────────────────────────────────────────────
      case 'rotate': {
        const angle = Number(cmd.angle);
        if (![0, 90, 180, 270].includes(angle)) {
          send({ error: 'rotate requires angle: 0, 90, 180, or 270' });
          return;
        }
        const transform = angle === 0 ? 'normal' : String(angle);
        const { execSync } = require('child_process');
        execSync(`wlr-randr --output HDMI-A-1 --transform ${transform}`);
        send({ rotated: angle });
        return;
      }

      // ── File list ─────────────────────────────────────────────────────────
      case 'list': {
        const files = media.listFiles();
        // Don't let a slow/unresponsive VLC block the file list response.
        // Fetch VLC status optimistically; fall back to a safe default.
        let base = { status: 'stopped', file: null, pos: 0, duration: 0, volume: 75 };
        try {
          base = await vlc.buildStatus(false);
        } catch {
          // VLC not ready yet — file list still goes through
        }
        base.files = files;
        send(base);
        return;   // skip the generic status send below
      }

      default:
        send({ error: 'Unknown action: ' + action });
        return;
    }

    // After every command except 'list', send back current VLC state
    // Give VLC a brief moment to update before reading status back
    await new Promise((r) => setTimeout(r, 150));
    const st = await vlc.buildStatus(false);
    send(st);

  } catch (err) {
    console.error('[cmd] Handler error:', err.message);
    send({ error: err.message });
  }
}

// ── Inbound: Data parser (newline-delimited JSON) ─────────────────────────────

function onData(chunk) {
  receiveBuffer += chunk.toString('utf8');
  const lines = receiveBuffer.split('\n');
  receiveBuffer = lines.pop();  // last element is the incomplete fragment (or '')

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const cmd = JSON.parse(trimmed);
      dispatch(cmd);
    } catch {
      console.warn('[bt] Malformed JSON, ignoring:', trimmed.slice(0, 80));
    }
  }
}

// ── Bluetooth server lifecycle ────────────────────────────────────────────────

function startListening() {
  server = new BluetoothSerialPortServer();

  server.listen(
    // ── Client connected ──────────────────────────────────────────────────
    (clientAddress) => {
      console.log('[bt] Phone connected:', clientAddress);
      connected     = true;
      receiveBuffer = '';

      server.on('data', onData);

      server.on('disconnected', () => {
        console.log('[bt] Phone disconnected');
        connected = false;
        stopStatusBroadcast();
        // Recreate server instance and wait for next connection
        setTimeout(startListening, 1000);
      });

      startStatusBroadcast();

      // Send current state immediately so the phone can sync its UI
      vlc.buildStatus(false)
        .then((st) => send(st))
        .catch(() => send({ status: 'stopped', file: null, pos: 0, duration: 0, volume: 0 }));
    },

    // ── Listen error ──────────────────────────────────────────────────────
    (err) => {
      console.error('[bt] Listen error:', err.message);
      console.log('[bt] Retrying in 5 s...');
      setTimeout(startListening, 5000);
    },

    // ── Options ───────────────────────────────────────────────────────────
    { uuid: BT_UUID, channel: BT_CHANNEL }
  );

  console.log(`[bt] Listening — UUID: ${BT_UUID}  channel: ${BT_CHANNEL}`);
}

// ── Startup sequence ──────────────────────────────────────────────────────────

async function boot() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Backpack Display System — BT Server  v1    ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Wait for VLC HTTP API to become available (VLC may still be starting)
  let vlcReady = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    vlcReady = await vlc.ping();
    if (vlcReady) break;
    console.log(`[vlc] Waiting for VLC... (attempt ${attempt}/10)`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!vlcReady) {
    console.warn('[vlc] WARNING: VLC is not responding. Commands will fail until VLC starts.');
    console.warn('[vlc] Make sure VLC is running with:');
    console.warn('[vlc]   vlc --intf dummy --extraintf http --http-password backpack --http-port 8080 --fullscreen');
  } else {
    console.log('[vlc] VLC HTTP API: OK');
  }

  const files = media.listFiles();
  console.log(`[media] ${files.length} file(s) in media directory`);
  if (files.length > 0) {
    files.slice(0, 5).forEach((f) => console.log('  •', f));
    if (files.length > 5) console.log(`  … and ${files.length - 5} more`);
  }

  console.log('');
  startUploadServer();
  startListening();
}

boot();

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[server] Shutting down...');
  stopStatusBroadcast();
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err.message);
  // Keep running — don't crash on a single bad packet
});

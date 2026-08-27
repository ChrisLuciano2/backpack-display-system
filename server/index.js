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
//   { "action": "screen", "state": "sleep" | "wake" }
//   { "action": "enqueue",      "file": "video.mp4" }
//   { "action": "clearqueue"  }
//   { "action": "queueremove", "index": 2 }
//   { "action": "queuereorder", "fromIndex": 2, "toIndex": 0 }
//   { "action": "queuejump",   "index": 2 }
//
// Pi → Phone (status):
//   { "status": "playing", "file": "video.mp4", "pos": 42, "duration": 3600, "volume": 75, "screen": "on", "queue": ["b.mp4","c.mp4"] }
//   { "files": ["a.mp4", "b.mp4"] }           // response to "list"
//   { "error": "File not found: ..." }
//
// The queue ("up next") is tracked entirely server-side — VLC only ever
// plays one file at a time via in_play. This lets next/prev/auto-advance
// all go through the same safe stop-then-play path (see vlc.js) instead of
// VLC's own playlist navigation, which was the source of the video-not-
// appearing bug when switching between items.

'use strict';

const { BluetoothSerialPortServer } = require('bluetooth-serial-port');
const vlc   = require('./vlc');
const media = require('./media');
const { startUploadServer } = require('./upload');
const path  = require('path');
const os    = require('os');
const { BT_UUID, BT_CHANNEL, STATUS_INTERVAL_MS } = require('./config');

// ── Network helpers ───────────────────────────────────────────────────────────

// Returns the Pi's WiFi (or ethernet) IPv4 address so the phone app can
// auto-configure the upload URL without the user typing an IP.
function getLocalIP() {
  const preferred = ['wlan0', 'wlan1', 'eth0'];
  const ifaces = os.networkInterfaces();
  for (const name of preferred) {
    for (const iface of (ifaces[name] || [])) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  // Fallback: first non-loopback IPv4
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

// ── State ─────────────────────────────────────────────────────────────────────

let server         = null;   // BluetoothSerialPortServer instance (recreated on each listen)
let connected      = false;  // Whether a phone client is currently connected
let receiveBuffer  = '';     // Incomplete JSON line accumulator
let statusTimer    = null;   // Periodic status broadcast interval
let queueTimer     = null;   // Queue-advance watcher interval
let screenOff      = false;  // Whether the monitor has been put to sleep via the "screen" command

// ── Server-managed queue ─────────────────────────────────────────────────────
// VLC only ever plays one file at a time (via vlc.playFile's safe stop+play).
// The queue itself — what's playing, what's next, what came before — lives
// here, not in VLC's own playlist, so every transition (tap-to-play,
// next/prev, natural end-of-clip) goes through the same reliable path.
let nowPlaying   = null;   // filename currently playing, or null
let upNext       = [];     // ordered filenames queued after nowPlaying
let history      = [];     // filenames played before nowPlaying, for "prev"
let userStopped  = false;  // true after an explicit stop — blocks auto-advance
let queueBusy    = false;  // reentrancy guard around advanceQueue()

const HDMI_OUTPUT = 'HDMI-A-1';
const QUEUE_POLL_MS = 500; // how often to check for natural end-of-clip

// Play a queued/selected file, tracking playback errors from a vanished file.
// Returns true on success, false if the file no longer exists on disk.
async function playQueuedFile(filename) {
  const fullPath = media.resolveFile(filename);
  if (!fullPath) return false;
  await vlc.playFile(fullPath, media.isImageFile(filename));
  return true;
}

// Advance to the next queued item after the current one ends naturally.
// Skips over any queued file that's vanished from disk since being queued.
async function advanceQueue() {
  if (nowPlaying) history.push(nowPlaying);
  nowPlaying = null;
  while (upNext.length > 0) {
    const next = upNext.shift();
    const ok = await playQueuedFile(next);
    if (ok) {
      nowPlaying = next;
      return;
    }
    console.warn('[queue] Skipping missing file:', next);
  }
}

// Polls VLC for natural end-of-clip (state becomes stopped without the user
// having explicitly stopped it) and auto-advances the queue when it happens.
function startQueueWatcher() {
  if (queueTimer) return;
  queueTimer = setInterval(async () => {
    if (!connected || !nowPlaying || userStopped || queueBusy) return;
    queueBusy = true;
    try {
      const raw = await vlc.rawStatus();
      if (raw.state === 'stopped' || !raw.state) {
        await advanceQueue();
        const st = await buildFullStatus();
        send(st);
      }
    } catch {
      // VLC momentarily unreachable — try again next tick
    } finally {
      queueBusy = false;
    }
  }, QUEUE_POLL_MS);
}

function stopQueueWatcher() {
  if (queueTimer) {
    clearInterval(queueTimer);
    queueTimer = null;
  }
}

// Build the standard status payload plus screen power state and the queue.
// screenOff/queue are server-side state (not something VLC knows about), so
// every status send needs to merge them in separately from vlc.buildStatus().
async function buildFullStatus() {
  const st = await vlc.buildStatus(false);
  st.screen = screenOff ? 'off' : 'on';
  st.queue = upNext.slice();
  return st;
}

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
      const st = await buildFullStatus();
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
      // Play/next/prev never touch upNext directly here — advanceQueue()
      // and the cases below own all queue mutation so state stays consistent.
      case 'play': {
        if (cmd.file) {
          const ok = await playQueuedFile(cmd.file);
          if (!ok) {
            send({ error: 'File not found: ' + cmd.file });
            return;
          }
          // Interrupts with a direct pick — doesn't touch upNext, so a
          // queue that was running resumes after this one ends.
          nowPlaying = cmd.file;
          userStopped = false;
        } else {
          // Resume current item without specifying a file
          userStopped = false;
          await vlc.resume();
        }
        break;
      }

      case 'pause':
        await vlc.pause();
        break;

      case 'resume':
        userStopped = false;
        await vlc.resume();
        break;

      case 'stop':
        userStopped = true;
        nowPlaying = null;
        await vlc.stop();
        break;

      case 'next': {
        if (upNext.length === 0) break; // nothing queued — no-op
        if (nowPlaying) history.push(nowPlaying);
        const next = upNext.shift();
        const ok = await playQueuedFile(next);
        if (!ok) {
          send({ error: 'Queued file not found: ' + next });
          return;
        }
        nowPlaying = next;
        userStopped = false;
        break;
      }

      case 'prev': {
        if (history.length === 0) break; // nothing to go back to — no-op
        if (nowPlaying) upNext.unshift(nowPlaying);
        const prevFile = history.pop();
        const ok = await playQueuedFile(prevFile);
        if (!ok) {
          send({ error: 'File not found: ' + prevFile });
          return;
        }
        nowPlaying = prevFile;
        userStopped = false;
        break;
      }

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

      // ── Display fit mode ──────────────────────────────────────────────────
      case 'displaymode': {
        const mode = cmd.mode;
        if (!['contain', 'cover', 'stretch'].includes(mode)) {
          send({ error: 'displaymode requires mode: contain, cover, or stretch' });
          return;
        }
        const ratio = ['16:9', '9:16'].includes(cmd.ratio) ? cmd.ratio : '16:9';
        await vlc.setDisplayMode(mode, ratio);
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
        execSync(`wlr-randr --output ${HDMI_OUTPUT} --transform ${transform}`);
        send({ rotated: angle });
        return;
      }

      // ── Screen power ─────────────────────────────────────────────────────
      // "sleep": pause playback (VLC holds the exact position) and power off
      // the HDMI output so the monitor itself goes dark/standby.
      // "wake": power the HDMI output back on and resume from that exact
      // position — no manual pos/file bookkeeping needed since VLC's own
      // pause state already preserves it.
      case 'screen': {
        const state = cmd.state;
        if (!['sleep', 'wake'].includes(state)) {
          send({ error: 'screen requires state: sleep or wake' });
          return;
        }
        const { execSync } = require('child_process');
        try {
          if (state === 'sleep') {
            await vlc.pause();
            execSync(`wlr-randr --output ${HDMI_OUTPUT} --off`);
            screenOff = true;
          } else {
            // Re-force 1920x1080 on wake — the display can forget its forced
            // mode across a power cycle and fall back to native 2256x1504.
            execSync(`wlr-randr --output ${HDMI_OUTPUT} --on --mode 1920x1080`);
            screenOff = false;
            // Give the panel a moment to reinitialize before resuming
            await new Promise((r) => setTimeout(r, 500));
            await vlc.resume();
          }
        } catch (err) {
          console.error('[screen] Command failed:', err.message);
          send({ error: 'Screen power command failed: ' + err.message });
          return;
        }
        break;
      }

      // ── Queue management ─────────────────────────────────────────────────
      // enqueue: append a file to the server-side upNext list. If nothing
      // is currently playing, starts the queue immediately instead of
      // sitting there with nothing to trigger it.
      case 'enqueue': {
        if (!cmd.file) {
          send({ error: 'enqueue requires a "file" field' });
          return;
        }
        if (!media.resolveFile(cmd.file)) {
          send({ error: 'File not found: ' + cmd.file });
          return;
        }
        upNext.push(cmd.file);
        send({ queued: cmd.file });
        if (!nowPlaying) {
          userStopped = false;
          await advanceQueue();
        }
        const st = await buildFullStatus();
        send(st);
        return;
      }

      // clearqueue: empty just the upNext list — does not stop whatever is
      // currently playing.
      case 'clearqueue': {
        upNext = [];
        const st = await buildFullStatus();
        send(st);
        return;
      }

      // queueremove: drop a single item out of upNext by its index.
      case 'queueremove': {
        const index = Number(cmd.index);
        if (!Number.isInteger(index) || index < 0 || index >= upNext.length) {
          send({ error: 'queueremove requires a valid "index"' });
          return;
        }
        upNext.splice(index, 1);
        const st = await buildFullStatus();
        send(st);
        return;
      }

      // queuereorder: move an upNext item from one position to another.
      case 'queuereorder': {
        const fromIndex = Number(cmd.fromIndex);
        const toIndex = Number(cmd.toIndex);
        if (
          !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
          fromIndex < 0 || fromIndex >= upNext.length ||
          toIndex < 0 || toIndex >= upNext.length
        ) {
          send({ error: 'queuereorder requires valid "fromIndex"/"toIndex"' });
          return;
        }
        const [item] = upNext.splice(fromIndex, 1);
        upNext.splice(toIndex, 0, item);
        const st = await buildFullStatus();
        send(st);
        return;
      }

      // queuejump: skip straight to an upNext item. Everything before it is
      // dropped (skipped, not "played"); the current item goes to history.
      case 'queuejump': {
        const index = Number(cmd.index);
        if (!Number.isInteger(index) || index < 0 || index >= upNext.length) {
          send({ error: 'queuejump requires a valid "index"' });
          return;
        }
        const target = upNext[index];
        const ok = await playQueuedFile(target);
        if (!ok) {
          send({ error: 'File not found: ' + target });
          return;
        }
        if (nowPlaying) history.push(nowPlaying);
        upNext = upNext.slice(index + 1);
        nowPlaying = target;
        userStopped = false;
        break;
      }

      // ── File list ─────────────────────────────────────────────────────────
      case 'list': {
        const { movies, media: mediaFiles } = media.listFilesGrouped();
        let base = { status: 'stopped', file: null, pos: 0, duration: 0, volume: 75, screen: screenOff ? 'off' : 'on', queue: upNext.slice() };
        try {
          base = await buildFullStatus();
        } catch {
          // VLC not ready yet — file list still goes through
        }
        // Send both the legacy flat list and the new grouped lists.
        // Include IP so the phone always gets it even if the on-connect
        // message arrived before the data listener was ready.
        base.files  = [...movies, ...mediaFiles];
        base.movies = movies;
        base.media  = mediaFiles;
        base.ip     = getLocalIP();
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
    const st = await buildFullStatus();
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
        stopQueueWatcher();
        // Recreate server instance and wait for next connection
        setTimeout(startListening, 1000);
      });

      startStatusBroadcast();
      startQueueWatcher();

      // Send current VLC state immediately so the phone UI syncs.
      buildFullStatus()
        .then((st) => send(st))
        .catch(() => send({ status: 'stopped', file: null, pos: 0, duration: 0, volume: 0, screen: screenOff ? 'off' : 'on', queue: upNext.slice() }));

      // Send IP as a dedicated message after 1 s — the phone's data listener
      // may not be registered yet at the moment of connection, so we delay
      // to guarantee delivery.
      setTimeout(() => {
        const ip = getLocalIP();
        if (ip) send({ ip });
      }, 1000);
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

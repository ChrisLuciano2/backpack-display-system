// server/index.js
// Backpack Display System — Bluetooth SPP Server
//
// Architecture:
//   Phone (React Native) ──BT Classic SPP──▶ This server ──HTTP──▶ VLC
//                                                        └─systemd─▶ RetroArch
//
// Protocol: newline-delimited JSON, both directions
//
// Phone → Pi (commands, protocol v1 — the installed app):
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
//
// ── Protocol v2 additions (Game Mode, Design Doc section 8) ──────────────────
// A v1 client (no "hello") gets exactly the v1 behavior above, unchanged. A v2
// client sends { "action": "hello", "v": 2 } first and gets back
//   { "hello": true, "v": 2, "mode": "video", "game": null, "token": null, "caps": [...] }
// Status messages additively carry "mode" ('video'|'game'|'switching'|'error'),
// "target" (the mode being switched to, else null) and "game"
// ({ id, name, system } or null) — a v1 client ignores fields it does not know,
// so this is safe to send unconditionally.
//
// New commands (any client may send these; a reply carries "id" back when the
// command included one):
//   { "action": "mode", "target": "video"|"game", "force"?: true }
//   { "action": "systems" }
//   { "action": "library", "system": "nes", "page"?: 0, "size"?: 50 }
//   { "action": "launchgame", "gameId": "nes:1a2b3c4d5e6f" }
//   { "action": "gamectl", "op": "pause"|"resume"|"reset"|"loadstate"|"savestate"|"quit"|"swap" }
//   { "action": "ping" }
//
// While mode is not "video", every Video Mode command above (play, pause,
// resume, stop, next, prev, volume, seek, displaymode, rotate, screen, enqueue,
// clearqueue, queueremove, queuereorder, queuejump) is refused with
//   { "error": "Video controls are off while Game Mode is running", "code": "not_in_mode" }
// "list" (the media file browser) is not a Video Mode command and still works
// in either mode.
//
// Not yet built (tracked in Jira, not silently missing): the upload token in
// "hello" is always null until the security hardening step wires it up
// (STG452-38); "gamectl swap" replies with code "not_implemented" until the
// player-swap story lands (STG452-61); health and storage fields are added to
// status in the health/telemetry step (STG452-63).

'use strict';

// DEBUG_TCP=1 swaps Bluetooth for a localhost only TCP port so the real server
// can be driven over SSH without a phone (see server/transport-tcp.js).
const { BluetoothSerialPortServer } = process.env.DEBUG_TCP === '1'
  ? require('./transport-tcp')
  : require('bluetooth-serial-port');
const vlc   = require('./vlc');
const media = require('./media');
const { startUploadServer } = require('./upload');
const { CommandQueue } = require('./commandQueue');
const units = require('./units');
const { ModeManager, ModeError } = require('./mode');
const { createRetroArchClient } = require('./retroarch');
const { createLibrary } = require('./library');
const { createLaunchFile } = require('./launchFile');
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

// ── Command serialization ────────────────────────────────────────────────────
// Every command that changes anything runs through one lane, one at a time, so
// two quick taps (or a tap during an auto-advance) can never run together.
// Read-only commands skip the lane so the app stays responsive.
const commandQueue = new CommandQueue();
const READ_ACTIONS = new Set(['list', 'hello', 'systems', 'library', 'ping']);
const DEFAULT_DEADLINE_MS = 5000;
const DEADLINES_MS = {
  play: 10000, next: 10000, prev: 10000, queuejump: 10000, enqueue: 10000, screen: 8000,
  mode: 12000, launchgame: 15000, gamectl: 5000,
};

// Video Mode commands. Refused while a game is running or a switch is in
// progress — see the protocol note at the top of this file.
const VIDEO_ACTIONS = new Set([
  'play', 'pause', 'resume', 'stop', 'next', 'prev', 'volume', 'seek',
  'displaymode', 'rotate', 'screen', 'enqueue', 'clearqueue',
  'queueremove', 'queuereorder', 'queuejump',
]);

function submit(cmd) {
  if (READ_ACTIONS.has(cmd.action)) {
    dispatch(cmd);
    return;
  }
  const timeoutMs = DEADLINES_MS[cmd.action] || DEFAULT_DEADLINE_MS;
  commandQueue
    .run(() => dispatch(cmd), { label: String(cmd.action), timeoutMs })
    .catch((err) => {
      console.error('[cmd] Failed:', err.message);
      const payload = { error: err.code === 'timeout' ? 'Command timed out: ' + cmd.action : err.message };
      if (cmd.id !== undefined) payload.id = cmd.id;
      send(payload);
    });
}

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

// ── Mode manager (Game Mode) ─────────────────────────────────────────────────
// The Pi owns the current mode (video / switching / game / error). This server
// only ever talks to the video and game "worlds" through the small interfaces
// below, so the same mode.js runs unmodified in the virtual Pi and on the real
// Pi — only what these functions actually call (systemctl, VLC, RetroArch)
// differs between the two.

let modeSuspended = false; // true whenever the queue watcher must leave VLC alone

const video = {
  // Captures enough of the current Video Mode state to restore it exactly
  // after a trip through Game Mode.
  async snapshot() {
    let pos = 0;
    try { pos = (await vlc.rawStatus()).time || 0; } catch { /* VLC may already be busy stopping */ }
    return { nowPlaying, pos, upNext: upNext.slice(), history: history.slice() };
  },
  async restore(snap) {
    upNext = snap.upNext.slice();
    history = snap.history.slice();
    if (snap.nowPlaying) {
      const ok = await playQueuedFile(snap.nowPlaying);
      if (ok) {
        nowPlaying = snap.nowPlaying;
        if (snap.pos > 0) {
          await new Promise((r) => setTimeout(r, 400)); // let playback actually start before seeking
          await vlc.seek(snap.pos);
        }
      }
    }
  },
  suspend() { modeSuspended = true; },
  resume() { modeSuspended = false; },
  async ping() {
    try { return !!(await vlc.rawStatus()).state; } catch { return false; }
  },
};

const library = createLibrary();
const launchFile = createLaunchFile();
const retroarchClient = createRetroArchClient();
const modeManager = new ModeManager({ units, retroarch: retroarchClient, video, launchFile, log: console });

let modeReady = false; // false until the systemd units exist and modeManager.init() succeeds

async function initModeManager() {
  try {
    await modeManager.init();
    modeManager.start(1000);
    modeReady = true;
    console.log('[mode] Ready — current mode:', modeManager.getState().mode);
  } catch (err) {
    // Expected on a Pi that has not been migrated to the systemd units yet
    // (Design Doc section 4 and 18 — that migration is a later build step).
    // Video Mode keeps working exactly as before via the legacy VLC startup
    // in boot(); Game Mode commands reply with a clear "not available" error.
    console.warn('[mode] Game Mode is not available on this Pi yet:', err.message);
    console.warn('[mode] Run the systemd unit installer, then restart the server.');
  }
}

modeManager.on('change', () => {
  if (!connected) return;
  buildFullStatus().then((st) => send(st)).catch(() => {});
});
modeManager.on('notice', (n) => {
  console.log('[mode] notice:', n.code, '—', n.message);
  if (!connected) return;
  send({ notice: { code: n.code, message: n.message } }); // additive, a v1 client ignores it
});

// Polls VLC for natural end-of-clip (state becomes stopped without the user
// having explicitly stopped it) and auto-advances the queue when it happens.
function startQueueWatcher() {
  if (queueTimer) return;
  queueTimer = setInterval(async () => {
    // Skip the tick while any command is queued or running, or while Game
    // Mode owns the display: the user's command (or the mode switch) owns
    // the state until it finishes.
    if (!connected || !nowPlaying || userStopped || queueBusy || modeSuspended || commandQueue.isBusy()) return;
    queueBusy = true;
    try {
      // The check and the advance run inside the command lane so a user command
      // that arrives now waits its turn instead of racing this advance.
      await commandQueue.run(async () => {
        // Re-check inside the lock: a command may have changed things since the tick fired.
        if (!connected || !nowPlaying || userStopped || modeSuspended) return;
        const raw = await vlc.rawStatus();
        if (raw.state === 'stopped' || !raw.state) {
          await advanceQueue();
          const st = await buildFullStatus();
          send(st);
        }
      }, { label: 'queue advance', timeoutMs: 10000 });
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

// Build the standard status payload plus screen power state, the queue, and
// (additively) the current mode and game. VLC being unreachable is expected
// while Game Mode is running, so that case falls back to a "stopped" shape
// instead of throwing — every caller can rely on this never rejecting.
async function buildFullStatus() {
  let st;
  try {
    st = await vlc.buildStatus(false);
  } catch {
    st = { status: 'stopped', file: null, pos: 0, duration: 0, volume: 0 };
  }
  st.screen = screenOff ? 'off' : 'on';
  st.queue = upNext.slice();
  const modeState = modeReady ? modeManager.getState() : { mode: 'video', target: null, phase: null, game: null };
  st.mode = modeState.mode;
  st.target = modeState.target;
  st.phase = modeState.phase;
  st.game = modeState.game;
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

  // Every reply to this command carries its id back, when it had one, so a v2
  // client can match a reply to the request that caused it. A v1 client never
  // sends an id and never looks for one, so this is safe either way.
  const reply = (obj) => send(cmd.id !== undefined ? { id: cmd.id, ...obj } : obj);

  // Video Mode commands are refused while Game Mode owns the screen. "list"
  // (the media browser) is not in VIDEO_ACTIONS and still works in either mode.
  if (VIDEO_ACTIONS.has(action) && modeReady && modeManager.getState().mode !== 'video') {
    reply({ error: 'Video controls are off while Game Mode is running', code: 'not_in_mode' });
    return;
  }

  try {
    switch (action) {

      // ── Playback control ─────────────────────────────────────────────────
      // Play/next/prev never touch upNext directly here — advanceQueue()
      // and the cases below own all queue mutation so state stays consistent.
      case 'play': {
        if (cmd.file) {
          const ok = await playQueuedFile(cmd.file);
          if (!ok) {
            reply({ error: 'File not found: ' + cmd.file });
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
          reply({ error: 'Queued file not found: ' + next });
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
          reply({ error: 'File not found: ' + prevFile });
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
          reply({ error: 'volume requires a numeric "level" (0-100)' });
          return;
        }
        await vlc.setVolume(level);
        break;
      }

      // ── Seek ──────────────────────────────────────────────────────────────
      case 'seek': {
        const seconds = Number(cmd.seconds);
        if (isNaN(seconds)) {
          reply({ error: 'seek requires a numeric "seconds" value' });
          return;
        }
        await vlc.seek(seconds);
        break;
      }

      // ── Display fit mode ──────────────────────────────────────────────────
      case 'displaymode': {
        const mode = cmd.mode;
        if (!['contain', 'cover', 'stretch'].includes(mode)) {
          reply({ error: 'displaymode requires mode: contain, cover, or stretch' });
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
          reply({ error: 'rotate requires angle: 0, 90, 180, or 270' });
          return;
        }
        const transform = angle === 0 ? 'normal' : String(angle);
        const { execSync } = require('child_process');
        execSync(`wlr-randr --output ${HDMI_OUTPUT} --transform ${transform}`);
        reply({ rotated: angle });
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
          reply({ error: 'screen requires state: sleep or wake' });
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
          reply({ error: 'Screen power command failed: ' + err.message });
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
          reply({ error: 'enqueue requires a "file" field' });
          return;
        }
        if (!media.resolveFile(cmd.file)) {
          reply({ error: 'File not found: ' + cmd.file });
          return;
        }
        upNext.push(cmd.file);
        reply({ queued: cmd.file });
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
          reply({ error: 'queueremove requires a valid "index"' });
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
          reply({ error: 'queuereorder requires valid "fromIndex"/"toIndex"' });
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
          reply({ error: 'queuejump requires a valid "index"' });
          return;
        }
        const target = upNext[index];
        const ok = await playQueuedFile(target);
        if (!ok) {
          reply({ error: 'File not found: ' + target });
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
        const base = await buildFullStatus();
        // Send both the legacy flat list and the new grouped lists.
        // Include IP so the phone always gets it even if the on-connect
        // message arrived before the data listener was ready.
        base.files  = [...movies, ...mediaFiles];
        base.movies = movies;
        base.media  = mediaFiles;
        base.ip     = getLocalIP();
        reply(base);
        return;   // skip the generic status send below
      }

      // ── Protocol v2: handshake ───────────────────────────────────────────
      case 'hello': {
        const modeState = modeReady ? modeManager.getState() : { mode: 'video', game: null };
        reply({
          hello: true,
          v: 2,
          mode: modeState.mode,
          phase: modeState.phase,
          game: modeState.game,
          // The upload token is wired up in the security hardening step
          // (STG452-38) — until then this is always null, not a bug.
          token: null,
          caps: ['mode', 'systems', 'library', 'launchgame', 'gamectl'],
        });
        return;
      }

      case 'ping': {
        reply({ pong: true });
        return;
      }

      // ── Game Mode: systems and library ───────────────────────────────────
      case 'systems': {
        reply({ systems: library.systems() });
        return;
      }

      case 'library': {
        const result = library.list(cmd.system, cmd.page, cmd.size);
        if (!result) {
          reply({ error: 'Unknown system: ' + cmd.system, code: 'invalid_id' });
          return;
        }
        reply({ library: result });
        return;
      }

      // ── Game Mode: switching, launching, in-game control ─────────────────
      case 'mode': {
        if (!modeReady) {
          reply({ error: 'Game Mode is not available on this Pi yet.', code: 'unavailable' });
          return;
        }
        if (cmd.target !== 'video' && cmd.target !== 'game') {
          reply({ error: 'mode requires target: video or game' });
          return;
        }
        try {
          const s = await modeManager.switchTo(cmd.target, { force: !!cmd.force });
          reply({ mode: s.mode, target: s.target, game: s.game });
        } catch (err) {
          if (err instanceof ModeError) {
            reply({ error: err.message, code: err.code });
          } else {
            throw err;
          }
        }
        return;
      }

      case 'launchgame': {
        if (!modeReady) {
          reply({ error: 'Game Mode is not available on this Pi yet.', code: 'unavailable' });
          return;
        }
        const game = library.resolve(cmd.gameId);
        if (!game) {
          reply({ error: 'That game is not available.', code: library.whyNot(cmd.gameId) });
          return;
        }
        try {
          const s = await modeManager.launch(game);
          reply({ phase: s.phase, game: s.game });
        } catch (err) {
          if (err instanceof ModeError) {
            reply({ error: err.message, code: err.code });
          } else {
            throw err;
          }
        }
        return;
      }

      case 'gamectl': {
        if (!modeReady) {
          reply({ error: 'Game Mode is not available on this Pi yet.', code: 'unavailable' });
          return;
        }
        const op = cmd.op;
        if (op === 'quit') {
          try {
            const s = await modeManager.quitToMenu();
            reply({ phase: s.phase });
          } catch (err) {
            if (err instanceof ModeError) reply({ error: err.message, code: err.code });
            else throw err;
          }
          return;
        }
        if (op === 'swap') {
          // FR-23 (STG452-61) — not built yet. Answered honestly rather than
          // silently doing nothing.
          reply({ error: 'Swapping players is not implemented yet.', code: 'not_implemented' });
          return;
        }
        if (!['pause', 'resume', 'reset', 'loadstate', 'savestate'].includes(op)) {
          reply({ error: 'Unknown gamectl op: ' + op });
          return;
        }
        if (!modeReady || modeManager.getState().mode !== 'game') {
          reply({ error: 'gamectl only works in Game Mode.', code: 'not_in_mode' });
          return;
        }
        if (op === 'savestate') {
          const saved = await retroarchClient.saveState();
          reply({ saved });
          return;
        }
        const method = { pause: 'pause', resume: 'resume', reset: 'reset', loadstate: 'loadState' }[op];
        await retroarchClient[method]();
        reply({ ok: true });
        return;
      }

      default:
        reply({ error: 'Unknown action: ' + action });
        return;
    }

    // After every command except the ones above that return early, send back
    // current state. Give VLC a brief moment to update before reading it back.
    await new Promise((r) => setTimeout(r, 150));
    const st = await buildFullStatus();
    reply(st);

  } catch (err) {
    console.error('[cmd] Handler error:', err.message);
    reply({ error: err.message });
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
      submit(cmd);
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

      // Send current state immediately so the phone UI syncs.
      buildFullStatus()
        .then((st) => send(st))
        .catch(() => send({ status: 'stopped', file: null, pos: 0, duration: 0, volume: 0, screen: screenOff ? 'off' : 'on', queue: upNext.slice(), mode: 'video', target: null, game: null }));

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
  console.log('║   Backpack Display System — BT Server  v2    ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  await initModeManager();

  if (!modeReady) {
    // Legacy path (pre-migration Pi): VLC is assumed already running, started
    // directly by start.sh as before. Once the systemd units are installed
    // (Design Doc section 18) this whole branch stops being used — mode.js's
    // own init() starts VLC through video-mode.service instead.
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
  }

  const files = media.listFiles();
  console.log(`[media] ${files.length} file(s) in media directory`);
  if (files.length > 0) {
    files.slice(0, 5).forEach((f) => console.log('  •', f));
    if (files.length > 5) console.log(`  … and ${files.length - 5} more`);
  }

  const systems = library.systems();
  console.log(`[library] ${systems.length} system(s) configured, ${systems.filter((s) => s.ready === 'ready').length} ready`);

  console.log('');
  startUploadServer();
  startListening();
}

boot();

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[server] Shutting down...');
  stopStatusBroadcast();
  modeManager.stop();
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err.message);
  // Keep running — don't crash on a single bad packet
});

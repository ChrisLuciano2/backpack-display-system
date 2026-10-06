// server/retroarch.js
// Talks to a running RetroArch. Every RetroArch specific detail lives in this file.
//
// Commands go through RetroArch's network command port (UDP, localhost). They have no
// reply: PAUSE_TOGGLE, SAVE_STATE, LOAD_STATE, RESET, CLOSE_CONTENT, QUIT, SHOW_MSG <text>.
//
// Status (is RetroArch up, and is a game running?) is read from the outside, through
// /proc, NOT with RetroArch's GET_STATUS command: on the Pi's RetroArch 1.20.0 that
// command never replies and crashes RetroArch (found on 2026-10-05). From /proc:
//   no retroarch process          -> null
//   process, command port not yet bound (still starting) -> null
//   process, no libretro core     -> CONTENTLESS (the menu)
//   process with a libretro core  -> PLAYING (name from the launch arguments)
// Whether the game is paused cannot be seen from outside, so pause state is remembered
// from the pause and resume calls made through this client.
//
// RETROARCH_STATUS=udp switches status back to GET_STATUS. The virtual Pi uses that,
// because its fake RetroArch is not a real retroarch process.

'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { RETROARCH_UDP_PORT, STATES_DIR } = require('./config');

const HOST = '127.0.0.1';

// "GET_STATUS PLAYING snes,Game Name,crc32=ab12" -> { state, system, name }
function parseStatus(text) {
  const t = String(text).trim();
  if (!t.startsWith('GET_STATUS')) return null;
  const rest = t.slice('GET_STATUS'.length).trim();
  if (rest === 'CONTENTLESS') return { state: 'CONTENTLESS', system: null, name: null };
  const m = rest.match(/^(PLAYING|PAUSED)\s+([^,]*),(.*?)(?:,crc32=[0-9a-fA-F]+)?$/);
  if (!m) return null;
  return { state: m[1], system: m[2] || null, name: m[3] || null };
}

// The game file in RetroArch's launch arguments: the last argument that is not an option
// and not the value of an option that takes one.
function contentFromArgs(args) {
  const takesValue = new Set(['-L', '--config', '--libretro', '-c', '--appendconfig', '-s', '--save', '-S', '--savestate']);
  let content = null;
  for (let i = 0; i < args.length; i++) {
    if (takesValue.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    content = args[i];
  }
  return content;
}

// True once something is listening on this UDP port, which RetroArch does only after it has
// finished starting. If /proc/net cannot be read, assume it is ready.
function portBound(procRoot, port) {
  const hex = Number(port).toString(16).toUpperCase().padStart(4, '0');
  let sawFile = false;
  for (const f of ['net/udp', 'net/udp6']) {
    let text;
    try { text = fs.readFileSync(path.join(procRoot, f), 'utf8'); } catch { continue; }
    sawFile = true;
    if (text.split('\n').some((l) => l.includes(':' + hex + ' '))) return true;
  }
  return !sawFile;
}

function procStatus(procRoot, port) {
  let pid = null;
  let entries = [];
  try { entries = fs.readdirSync(procRoot); } catch { return null; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (fs.readFileSync(path.join(procRoot, e, 'comm'), 'utf8').trim() === 'retroarch') { pid = e; break; }
    } catch { /* process ended while we looked */ }
  }
  if (!pid) return null;
  if (!portBound(procRoot, port)) return null; // still starting up

  let maps = '';
  try { maps = fs.readFileSync(path.join(procRoot, pid, 'maps'), 'utf8'); } catch { return null; }
  const core = maps.match(/([^\s/]+)_libretro\.so/);
  if (!core) return { state: 'CONTENTLESS', system: null, name: null };

  let name = null;
  try {
    const args = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean).slice(1);
    const content = contentFromArgs(args);
    if (content) name = path.basename(content);
  } catch { /* leave the name empty */ }
  return { state: 'PLAYING', system: core[1], name };
}

function createRetroArchClient({
  port = RETROARCH_UDP_PORT,
  statesDir = STATES_DIR,
  timeoutMs = 800,
  statusMode = process.env.RETROARCH_STATUS === 'udp' ? 'udp' : 'proc',
  procRoot = '/proc',
} = {}) {
  let paused = false;
  let lastName = null;

  function send(cmd) {
    return new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      s.send(cmd, port, HOST, () => { s.close(); resolve(); });
      s.on('error', () => { try { s.close(); } catch { /* closed */ } resolve(); });
    });
  }

  function ask(cmd) {
    return new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      const timer = setTimeout(() => { try { s.close(); } catch { /* closed */ } resolve(null); }, timeoutMs);
      s.on('message', (m) => { clearTimeout(timer); try { s.close(); } catch { /* closed */ } resolve(m.toString('utf8')); });
      s.on('error', () => { clearTimeout(timer); try { s.close(); } catch { /* closed */ } resolve(null); });
      s.send(cmd, port, HOST, (err) => { if (err) { clearTimeout(timer); try { s.close(); } catch { /* closed */ } resolve(null); } });
    });
  }

  // null when RetroArch is not running.
  async function status() {
    let s;
    if (statusMode === 'udp') {
      const reply = await ask('GET_STATUS');
      s = reply === null ? null : parseStatus(reply);
    } else {
      s = procStatus(procRoot, port);
    }
    if (s && s.state === 'PLAYING') {
      if (s.name !== lastName) { paused = false; lastName = s.name; } // a different game is never paused
      if (paused) s = Object.assign({}, s, { state: 'PAUSED' });
    } else {
      paused = false;
      lastName = null;
    }
    return s;
  }

  // The newest state file for this game written after `since` (ms), or null. RetroArch keeps
  // states in a folder per emulator core (for example states/Snes9x/Game.state), so look in
  // the states folder and one level below it.
  function findStateSince(gameName, since) {
    if (!gameName) return null;
    const base = path.basename(gameName, path.extname(gameName));
    let best = null;
    const dirs = [statesDir];
    try {
      for (const e of fs.readdirSync(statesDir, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push(path.join(statesDir, e.name));
      }
    } catch { return null; }
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith(base) || f.endsWith('.auto')) continue;
        try {
          const m = fs.statSync(path.join(dir, f)).mtimeMs;
          if (m >= since && (!best || m > best.mtime)) best = { file: path.join(dir, f), mtime: m };
        } catch { /* vanished */ }
      }
    }
    return best;
  }

  return {
    status,
    parseStatus,

    // PAUSE_TOGGLE flips, so remember the state to make pause and resume safe to repeat.
    async pause() {
      const s = await status();
      if (s && s.state === 'PLAYING') { await send('PAUSE_TOGGLE'); paused = true; }
    },
    async resume() {
      const s = await status();
      if (s && s.state === 'PAUSED') { await send('PAUSE_TOGGLE'); paused = false; }
    },
    async reset() { await send('RESET'); paused = false; },
    async loadState() { await send('LOAD_STATE'); },
    async closeContent() { await send('CLOSE_CONTENT'); paused = false; },
    async quit() { await send('QUIT'); },
    async showMessage(text) { await send('SHOW_MSG ' + String(text).replace(/[\r\n]+/g, ' ')); },

    // UDP has no reply for SAVE_STATE, so confirm by watching for the state file.
    // Returns true when a fresh state file appears.
    async saveState(waitMs = 2000) {
      const s = await status();
      if (!s || s.state === 'CONTENTLESS') return false;
      const since = Date.now() - 50;
      await send('SAVE_STATE');
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (findStateSince(s.name, since)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    },
  };
}

module.exports = { createRetroArchClient, parseStatus, contentFromArgs };

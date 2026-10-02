// server/retroarch.js
// Talks to a running RetroArch through its network command port (UDP, localhost).
// Every RetroArch specific detail lives in this file: the command names, the port
// and the status reply format. All of it is from general knowledge of RetroArch and
// is checked against the real thing in Phase 0 (Jira STG452-41).
//
//   GET_STATUS      -> "GET_STATUS CONTENTLESS"
//                      "GET_STATUS PLAYING <system>,<name>,crc32=<hex>"
//                      "GET_STATUS PAUSED  <system>,<name>,crc32=<hex>"
//   PAUSE_TOGGLE, SAVE_STATE, LOAD_STATE, RESET, CLOSE_CONTENT, QUIT, SHOW_MSG <text>
//                   (no reply)

'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { RETROARCH_UDP_PORT, STATES_DIR } = require('./config');

const HOST = '127.0.0.1';

function parseStatus(text) {
  const t = String(text).trim();
  if (!t.startsWith('GET_STATUS')) return null;
  const rest = t.slice('GET_STATUS'.length).trim();
  if (rest === 'CONTENTLESS') return { state: 'CONTENTLESS', system: null, name: null };
  const m = rest.match(/^(PLAYING|PAUSED)\s+([^,]*),(.*?)(?:,crc32=[0-9a-fA-F]+)?$/);
  if (!m) return null;
  return { state: m[1], system: m[2] || null, name: m[3] || null };
}

function createRetroArchClient({ port = RETROARCH_UDP_PORT, statesDir = STATES_DIR, timeoutMs = 800 } = {}) {
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

  // null when RetroArch is not running or not answering yet.
  async function status() {
    const reply = await ask('GET_STATUS');
    return reply === null ? null : parseStatus(reply);
  }

  // The newest state file for this game written after `since` (ms), or null.
  // RetroArch names state files after the game, so match on the name without extension.
  function findStateSince(gameName, since) {
    if (!gameName) return null;
    const base = path.basename(gameName, path.extname(gameName));
    let best = null;
    try {
      for (const f of fs.readdirSync(statesDir)) {
        if (!f.startsWith(base) || f.endsWith('.auto')) continue;
        const m = fs.statSync(path.join(statesDir, f)).mtimeMs;
        if (m >= since && (!best || m > best.mtime)) best = { file: f, mtime: m };
      }
    } catch { /* no states directory yet */ }
    return best;
  }

  return {
    status,
    parseStatus,

    // PAUSE_TOGGLE flips, so check first to make pause and resume idempotent.
    async pause() { const s = await status(); if (s && s.state === 'PLAYING') await send('PAUSE_TOGGLE'); },
    async resume() { const s = await status(); if (s && s.state === 'PAUSED') await send('PAUSE_TOGGLE'); },
    async reset() { await send('RESET'); },
    async loadState() { await send('LOAD_STATE'); },
    async closeContent() { await send('CLOSE_CONTENT'); },
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

module.exports = { createRetroArchClient, parseStatus };

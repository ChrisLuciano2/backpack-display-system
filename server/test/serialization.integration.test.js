'use strict';

// Runs the real server/index.js against a fake Bluetooth server and a fake VLC,
// so the wiring (submit -> command queue -> dispatch, and the queue watcher)
// is tested on any machine, not only on the Pi.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fakes ────────────────────────────────────────────────────────────────────

const events = [];        // ordered record of fake VLC activity
let active = 0;           // playFile calls in flight
let maxActive = 0;        // most playFile calls ever in flight at once
let vlcState = 'playing'; // what rawStatus reports
let playDelayMs = 25;     // how long the next playFile takes

const fakeVlc = {
  async ping() { return true; },
  async rawStatus() { return { state: vlcState }; },
  async buildStatus() {
    return { status: vlcState, file: null, pos: 0, duration: 0, volume: 75 };
  },
  async playFile(p) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push('start ' + path.basename(p));
    const wasState = vlcState;
    vlcState = 'stopped';            // VLC reports stopped while switching
    await sleep(playDelayMs);
    vlcState = 'playing';
    events.push('end ' + path.basename(p));
    active -= 1;
    return wasState;
  },
  async pause() {}, async resume() {}, async stop() {},
  async setVolume() {}, async seek() {}, async setDisplayMode() {},
};

const fakeMedia = {
  listFiles: () => [],
  listFilesGrouped: () => ({ movies: [], media: [] }),
  resolveFile: (f) => '/media/' + f,
  isImageFile: () => false,
};

class FakeServer {
  constructor() {
    this.handlers = {};
    this.writes = [];
    FakeServer.instances.push(this);
  }
  listen(onConnect, onError) { this._onConnect = onConnect; this._onError = onError; }
  on(evt, fn) { this.handlers[evt] = fn; }
  write(buf, cb) { this.writes.push(buf.toString('utf8')); if (cb) cb(); }
  close() {}
  phoneConnects() { this._onConnect('AA:BB:CC:DD:EE:FF'); }
  phoneSends(obj) { this.handlers.data(Buffer.from(JSON.stringify(obj) + '\n')); }
  phoneDisconnects() { this.handlers.disconnected(); }
}
FakeServer.instances = [];

// ── Load the real server with the fakes injected ─────────────────────────────

function loadServer() {
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'bluetooth-serial-port') return { BluetoothSerialPortServer: FakeServer };
    const fromIndex = parent && parent.filename && path.basename(parent.filename) === 'index.js';
    if (fromIndex && request === './vlc') return fakeVlc;
    if (fromIndex && request === './media') return fakeMedia;
    if (fromIndex && request === './upload') return { startUploadServer() {} };
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    require('../index.js');
  } finally {
    Module._load = origLoad;
  }
}

async function waitFor(cond, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('real server: serializes commands and the watcher never races a user command', async () => {
  loadServer();
  await waitFor(() => FakeServer.instances.length > 0 && FakeServer.instances[0]._onConnect);
  const phone = FakeServer.instances[0];
  phone.phoneConnects();

  try {
    // 1. Double tap: two plays arrive in the same instant. They must not overlap.
    phone.phoneSends({ action: 'play', file: 'a.mp4' });
    phone.phoneSends({ action: 'play', file: 'b.mp4' });
    await sleep(500);
    assert.equal(maxActive, 1, 'two playFile calls ran at the same time');
    assert.deepEqual(events, ['start a.mp4', 'end a.mp4', 'start b.mp4', 'end b.mp4']);

    // 2. Something is queued behind the current item.
    events.length = 0;
    phone.phoneSends({ action: 'enqueue', file: 'q.mp4' });
    await sleep(400);
    assert.deepEqual(events, [], 'enqueue must not start playback while something is playing');

    // 3. A slow user switch. VLC reports "stopped" for 900 ms, and the watcher ticks
    //    every 500 ms. The watcher must wait, not advance the queue over the user's pick.
    playDelayMs = 900;
    phone.phoneSends({ action: 'play', file: 'c.mp4' });
    await sleep(1400);
    assert.deepEqual(events, ['start c.mp4', 'end c.mp4'], 'watcher advanced during a user switch: ' + events.join(', '));
  } finally {
    // Always stop the server timers, even when an assertion fails, so the process can exit.
    phone.phoneDisconnects();
  }
});

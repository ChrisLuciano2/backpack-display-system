'use strict';

// STG452-63 end to end: the real server/index.js, with a fake phone link, a fake VLC and FAKE SENSORS,
// shows that storage and health reach the phone in "hello", in status and in the "health" action,
// and that a v1 client (no hello) keeps working. The sensors are fake because a laptop has no
// vcgencmd; the Pi's real values are verified on the hardware (Phase 0 retest).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const realSystem = require('../system');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 * 1024 * 1024;

// What the fake Pi reports; tests change these between samples.
const sensors = { temp: 52, throttled: 0, percent: 30 };

const fakeVlc = {
  async ping() { return true; },
  async rawStatus() { return { state: 'stopped' }; },
  async buildStatus() { return { status: 'stopped', file: null, pos: 0, duration: 0, volume: 75 }; },
  async playFile() { return 'stopped'; },
  async pause() {}, async resume() {}, async stop() {}, async setVolume() {}, async seek() {}, async setDisplayMode() {},
};
const fakeMedia = {
  listFiles: () => [], listFilesGrouped: () => ({ movies: [], media: [] }),
  resolveFile: (f) => '/media/' + f, isImageFile: () => false,
};

class FakeServer {
  constructor() { this.handlers = {}; this.writes = []; FakeServer.instances.push(this); }
  listen(onConnect) { this._onConnect = onConnect; }
  on(evt, fn) { this.handlers[evt] = fn; }
  write(buf, cb) { this.writes.push(JSON.parse(buf.toString('utf8'))); if (cb) cb(); }
  close() {}
  phoneConnects() { this._onConnect('AA:BB:CC:DD:EE:FF'); }
  phoneSends(obj) { this.handlers.data(Buffer.from(JSON.stringify(obj) + '\n')); }
  phoneDisconnects() { this.handlers.disconnected(); }
}
FakeServer.instances = [];

// The real system.js, but with readers that return the fake sensor values.
const fakeSystem = {
  ...realSystem,
  createMonitor: (opts) => realSystem.createMonitor({
    ...opts,
    readTemp: async () => sensors.temp,
    readThrottled: async () => sensors.throttled,
    readStorage: async (p) => ({ path: p, totalBytes: 128 * GB, usedBytes: (128 * GB * sensors.percent) / 100, percent: sensors.percent }),
  }),
};

function loadServer() {
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'bluetooth-serial-port') return { BluetoothSerialPortServer: FakeServer };
    const fromIndex = parent && parent.filename && path.basename(parent.filename) === 'index.js';
    if (fromIndex && request === './vlc') return fakeVlc;
    if (fromIndex && request === './media') return fakeMedia;
    if (fromIndex && request === './upload') return { startUploadServer() {} };
    if (fromIndex && request === './system') return fakeSystem;
    return origLoad.call(this, request, parent, ...rest);
  };
  try { require('../index.js'); } finally { Module._load = origLoad; }
}

async function waitFor(cond, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

test('STG452-63: health and storage reach the phone, and warnings follow the sensors', async () => {
  loadServer();
  await waitFor(() => FakeServer.instances.length > 0 && FakeServer.instances[0]._onConnect);
  const phone = FakeServer.instances[0];
  phone.phoneConnects();
  const lastWith = (key) => [...phone.writes].reverse().find((w) => key in w);

  try {
    // 1. A v2 phone says hello. The monitor's first sample is taken at boot.
    await sleep(150);
    phone.phoneSends({ action: 'hello', v: 2 });
    await waitFor(() => lastWith('hello'));
    const hello = lastWith('hello');
    assert.ok(hello.caps.includes('health'), 'hello advertises the health capability');
    assert.equal(hello.health.tempC, 52);
    assert.equal(hello.health.level, 'ok');
    assert.deepEqual(hello.health.warnings, []);
    assert.equal(hello.storage.level, 'ok');
    assert.equal(hello.storage.totalGB, 128);

    // 2. FR-11: storage fills to 70 percent, then 90. FR-16: under-voltage and heat trip together.
    sensors.percent = 72;
    phone.phoneSends({ action: 'health' });
    await waitFor(() => lastWith('events') && lastWith('events').storage.level === 'amber');
    assert.equal(lastWith('events').health.level, 'amber');

    sensors.percent = 91; sensors.throttled = 0x1; sensors.temp = 78;
    phone.phoneSends({ action: 'health' });
    await waitFor(() => lastWith('events') && lastWith('events').storage.level === 'red');
    const h = lastWith('events');
    assert.equal(h.health.level, 'red');
    assert.deepEqual(h.health.warnings.map((w) => w.code).sort(), ['storage_red', 'temp_high', 'undervolt']);
    assert.equal(h.health.undervolt, true);
    assert.ok(h.events.some((e) => e.kind === 'warning' && e.code === 'undervolt'), 'the event log recorded the under-voltage');

    // 3. The same fields ride on the normal status reply (every command is answered with one).
    phone.phoneSends({ action: 'pause' });   // every command is answered with a status
    await waitFor(() => phone.writes.some((w) => w.status !== undefined && w.health && w.health.level === 'red'));
    const st = [...phone.writes].reverse().find((w) => w.status !== undefined);
    assert.equal(st.storage.level, 'red');
    assert.equal(st.health.tempC, 78);

    // 4. Everything recovers: warnings clear and the log says so.
    sensors.percent = 30; sensors.throttled = 0; sensors.temp = 50;
    phone.phoneSends({ action: 'health' });
    await waitFor(() => lastWith('events') && lastWith('events').health.level === 'ok');
    assert.deepEqual(lastWith('events').health.warnings, []);
    assert.ok(lastWith('events').events.some((e) => e.kind === 'cleared' && e.code === 'undervolt'));

    // 5. A v1 client that never says hello still gets a working status (with the extra fields).
    phone.writes.length = 0;
    phone.phoneSends({ action: 'pause' });
    await waitFor(() => phone.writes.some((w) => w.status !== undefined));
    const v1 = phone.writes.find((w) => w.status !== undefined);
    assert.equal(v1.status, 'stopped');
    assert.equal(v1.screen, 'on');
  } finally {
    phone.phoneDisconnects();
  }
});

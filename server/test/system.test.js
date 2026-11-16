'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const {
  createMonitor, parseTemp, parseThrottled, decodeThrottled, storageLevel,
} = require('../system');

const GB = 1024 * 1024 * 1024;
const store = (percent, total = 100) => ({
  path: '/roms', totalBytes: total * GB, usedBytes: (total * GB * percent) / 100, percent,
});

// A monitor whose readers return fixed values (a null means "this reader fails").
function monitorWith({ temp = 40, throttled = 0, storage = store(10), extra = {} } = {}) {
  const state = { temp, throttled, storage };
  const m = createMonitor({
    storagePaths: ['/roms'],
    readTemp: async () => { if (state.temp === null) throw new Error('no sensor'); return state.temp; },
    readThrottled: async () => { if (state.throttled === null) throw new Error('no vcgencmd'); return state.throttled; },
    readStorage: async () => { if (state.storage === null) throw new Error('no mount'); return state.storage; },
    now: () => new Date('2026-11-15T20:00:00Z'),
    ...extra,
  });
  return { m, state };
}

// ── parsing ───────────────────────────────────────────────────────────────────

test('parseTemp reads vcgencmd output and rejects anything else', () => {
  assert.equal(parseTemp("temp=52.1'C"), 52.1);
  assert.equal(parseTemp("temp=68.6'C\n"), 68.6);
  assert.equal(parseTemp('garbage'), null);
  assert.equal(parseTemp(''), null);
  assert.equal(parseTemp(undefined), null);
});

test('parseThrottled reads the hex flag word', () => {
  assert.equal(parseThrottled('throttled=0x0'), 0);
  assert.equal(parseThrottled('throttled=0x50005\n'), 0x50005);
  assert.equal(parseThrottled('nope'), null);
});

test('decodeThrottled decodes the bits the design names', () => {
  const clean = decodeThrottled(0);
  assert.deepEqual(Object.values(clean).filter(Boolean), []);
  const d = decodeThrottled(0x50005);   // under-voltage + throttled now, and both have occurred
  assert.equal(d.undervolt, true);
  assert.equal(d.throttled, true);
  assert.equal(d.softTempLimit, false);
  assert.equal(d.undervoltOccurred, true);
  assert.equal(d.throttledOccurred, true);
  assert.equal(decodeThrottled(0x8).softTempLimit, true, 'bit 3 is the soft temperature limit');
  assert.equal(decodeThrottled(0x2).armCapped, true);
});

// ── FR-11: storage warning levels ─────────────────────────────────────────────

test('FR-11: storage is ok below 70, amber from 70, red from 90', () => {
  assert.equal(storageLevel(0), 'ok');
  assert.equal(storageLevel(69.9), 'ok');
  assert.equal(storageLevel(70), 'amber');
  assert.equal(storageLevel(89.9), 'amber');
  assert.equal(storageLevel(90), 'red');
  assert.equal(storageLevel(100), 'red');
  assert.equal(storageLevel(null), null);
});

test('FR-11: the snapshot carries used and total GB, and the level', async () => {
  const { m } = monitorWith({ storage: store(72, 128) });
  const s = await m.sample();
  assert.equal(s.storage.totalGB, 128);
  assert.equal(s.storage.usedGB, 92.2);
  assert.equal(s.storage.percent, 72);
  assert.equal(s.storage.level, 'amber');
  assert.ok(s.health.warnings.some((w) => w.code === 'storage_amber'));
});

test('FR-11: red at 90 percent and the health level follows the worst warning', async () => {
  const { m } = monitorWith({ storage: store(93) });
  const s = await m.sample();
  assert.equal(s.storage.level, 'red');
  assert.equal(s.health.level, 'red');
});

test('FR-11: with several mounts the fullest one is reported', async () => {
  const m = createMonitor({
    storagePaths: ['/roms', '/media'],
    readTemp: async () => 40,
    readThrottled: async () => 0,
    readStorage: async (p) => (p === '/roms' ? { ...store(20), path: '/roms' } : { ...store(91), path: '/media' }),
  });
  const s = await m.sample();
  assert.equal(s.storage.path, '/media');
  assert.equal(s.storage.level, 'red');
});

// ── FR-16: temperature, throttle flags and undervoltage ───────────────────────

test('FR-16: a healthy Pi has no warnings', async () => {
  const { m } = monitorWith({ temp: 52, throttled: 0, storage: store(30) });
  const s = await m.sample();
  assert.deepEqual(s.health.warnings, []);
  assert.equal(s.health.level, 'ok');
  assert.equal(s.health.tempC, 52);
  assert.equal(s.health.throttled, '0x0');
  assert.equal(s.health.undervolt, false);
});

test('FR-16: temperature trips at 75 C and not below it', async () => {
  const cool = await monitorWith({ temp: 74.9 }).m.sample();
  assert.equal(cool.health.warnings.length, 0);
  const hot = await monitorWith({ temp: 75 }).m.sample();
  assert.deepEqual(hot.health.warnings.map((w) => w.code), ['temp_high']);
  assert.equal(hot.health.level, 'amber');
});

test('FR-16: under-voltage now trips a red warning', async () => {
  const s = await monitorWith({ throttled: 0x1 }).m.sample();
  assert.deepEqual(s.health.warnings.map((w) => w.code), ['undervolt']);
  assert.equal(s.health.level, 'red');
  assert.equal(s.health.undervolt, true);
});

test('FR-16: throttled now (bit 2) and soft temperature limit (bit 3) each trip', async () => {
  const t = await monitorWith({ throttled: 0x4 }).m.sample();
  assert.deepEqual(t.health.warnings.map((w) => w.code), ['throttled']);
  const soft = await monitorWith({ throttled: 0x8 }).m.sample();
  assert.deepEqual(soft.health.warnings.map((w) => w.code), ['soft_temp_limit']);
});

test('FR-16: the owner-reported case: under-voltage happened earlier but is not happening now', async () => {
  // 0x50000: under-voltage and throttling HAVE occurred since boot, none right now.
  const s = await monitorWith({ throttled: 0x50000 }).m.sample();
  assert.deepEqual(s.health.warnings, [], 'a past event is history, not a banner');
  assert.equal(s.health.occurred.undervolt, true, 'but it is still reported so the app can show it');
  assert.equal(s.health.occurred.throttled, true);
});

test('FR-16: several things at once, all listed', async () => {
  const s = await monitorWith({ temp: 80, throttled: 0x5, storage: store(95) }).m.sample();
  assert.deepEqual(s.health.warnings.map((w) => w.code).sort(), ['storage_red', 'temp_high', 'throttled', 'undervolt']);
  assert.equal(s.health.level, 'red');
});

// ── failure and events ────────────────────────────────────────────────────────

test('readers that fail give nulls and never throw (a laptop with no vcgencmd)', async () => {
  const { m } = monitorWith({ temp: null, throttled: null, storage: null });
  const s = await m.sample();
  assert.equal(s.storage, null);
  assert.equal(s.health.tempC, null);
  assert.equal(s.health.throttled, null);
  assert.equal(s.health.undervolt, null);
  assert.deepEqual(s.health.warnings, []);
});

test('a warning is logged once when it appears and once when it clears', async () => {
  const seen = [];
  const { m, state } = monitorWith({ extra: { onEvent: (e) => seen.push(e.kind + ':' + e.code) } });
  await m.sample();
  assert.deepEqual(seen, []);
  state.throttled = 0x1;
  await m.sample(); await m.sample(); await m.sample();   // still tripped: no repeats
  assert.deepEqual(seen, ['warning:undervolt']);
  state.throttled = 0;
  await m.sample();
  assert.deepEqual(seen, ['warning:undervolt', 'cleared:undervolt']);
  state.throttled = 0x1;
  await m.sample();
  assert.deepEqual(seen, ['warning:undervolt', 'cleared:undervolt', 'warning:undervolt']);
  assert.equal(m.events().length, 3);
  assert.equal(m.events()[0].at, '2026-11-15T20:00:00.000Z');
});

test('the event log keeps only the latest 20', async () => {
  const { m, state } = monitorWith();
  for (let i = 0; i < 15; i++) { state.throttled = 0x1; await m.sample(); state.throttled = 0; await m.sample(); }
  assert.equal(m.events().length, 20);
});

test('a broken event listener does not stop sampling', async () => {
  const { m, state } = monitorWith({ extra: { onEvent: () => { throw new Error('listener bug'); } } });
  state.throttled = 0x1;
  const s = await m.sample();
  assert.equal(s.health.level, 'red');
});

test('overlapping samples share one run', async () => {
  let calls = 0;
  const m = createMonitor({
    storagePaths: [],
    readTemp: async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return 40; },
    readThrottled: async () => 0,
  });
  await Promise.all([m.sample(), m.sample(), m.sample()]);
  assert.equal(calls, 1, 'a slow reader must not stack up calls');
});

test('start() samples on a timer and stop() ends it', async () => {
  let n = 0;
  const m = createMonitor({ storagePaths: [], intervalMs: 20, readTemp: async () => { n += 1; return 40; }, readThrottled: async () => 0 });
  m.start();
  await new Promise((r) => setTimeout(r, 120));
  m.stop();
  const after = n;
  assert.ok(after >= 3, 'sampled at least a few times, got ' + after);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(n, after, 'no samples after stop');
  assert.notEqual(m.snapshot(), null);
});

// ── the real storage reader, on whatever machine runs the tests ──────────────

test('the real storage reader returns sane numbers for a real folder', async () => {
  const m = createMonitor({ storagePaths: [os.tmpdir()], readTemp: async () => 40, readThrottled: async () => 0 });
  const s = await m.sample();
  assert.ok(s.storage, 'statfs worked on ' + os.tmpdir());
  assert.ok(s.storage.totalGB > 0);
  assert.ok(s.storage.usedGB >= 0 && s.storage.usedGB <= s.storage.totalGB);
  assert.ok(s.storage.percent >= 0 && s.storage.percent <= 100);
  assert.ok(['ok', 'amber', 'red'].includes(s.storage.level));
});

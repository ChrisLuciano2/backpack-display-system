'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRetroArchClient, parseStatus } = require('../retroarch');
const { createLaunchFile } = require('../launchFile');

// ── parseStatus ──────────────────────────────────────────────────────────────
test('parseStatus: contentless', () => {
  assert.deepEqual(parseStatus('GET_STATUS CONTENTLESS'), { state: 'CONTENTLESS', system: null, name: null });
});
test('parseStatus: playing with system, name and crc', () => {
  assert.deepEqual(parseStatus('GET_STATUS PLAYING super_nes,Chrono Trigger,crc32=abcd1234'),
    { state: 'PLAYING', system: 'super_nes', name: 'Chrono Trigger' });
});
test('parseStatus: paused', () => {
  assert.equal(parseStatus('GET_STATUS PAUSED nes,Demo,crc32=00000000').state, 'PAUSED');
});
test('parseStatus: a game name containing commas survives', () => {
  assert.equal(parseStatus('GET_STATUS PLAYING nes,Hello, World, Vol 2,crc32=ff').name, 'Hello, World, Vol 2');
});
test('parseStatus: garbage is null', () => {
  assert.equal(parseStatus('nonsense'), null);
  assert.equal(parseStatus(''), null);
});

// ── client against a fake RetroArch on a UDP port ────────────────────────────
function fakeRetroArch(initial) {
  const state = { mode: initial, received: [] };
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf, rinfo) => {
    const cmd = buf.toString().trim();
    state.received.push(cmd);
    if (cmd === 'GET_STATUS') {
      const reply = state.mode === 'CONTENTLESS' ? 'GET_STATUS CONTENTLESS' : `GET_STATUS ${state.mode} nes,Demo Game A.nes,crc32=00`;
      sock.send(reply, rinfo.port, rinfo.address);
    }
    if (cmd === 'PAUSE_TOGGLE') state.mode = state.mode === 'PLAYING' ? 'PAUSED' : 'PLAYING';
    if (cmd === 'SAVE_STATE' && state.onSave) state.onSave();
  });
  return new Promise((resolve) => {
    sock.bind(0, '127.0.0.1', () => resolve({ state, port: sock.address().port, close: () => sock.close() }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('status: parsed reply, and null when nothing is listening', async () => {
  const ra = await fakeRetroArch('PLAYING');
  const client = createRetroArchClient({ port: ra.port, timeoutMs: 300 });
  assert.equal((await client.status()).state, 'PLAYING');
  ra.close();
  const dead = createRetroArchClient({ port: ra.port, timeoutMs: 200 });
  assert.equal(await dead.status(), null);
});

test('pause and resume are idempotent even though the command is a toggle', async () => {
  const ra = await fakeRetroArch('PLAYING');
  const c = createRetroArchClient({ port: ra.port, timeoutMs: 300 });
  await c.pause(); await sleep(50);
  assert.equal(ra.state.mode, 'PAUSED');
  await c.pause(); await sleep(50);                 // already paused: must not toggle back
  assert.equal(ra.state.mode, 'PAUSED');
  await c.resume(); await sleep(50);
  assert.equal(ra.state.mode, 'PLAYING');
  await c.resume(); await sleep(50);                // already playing: must not toggle
  assert.equal(ra.state.mode, 'PLAYING');
  ra.close();
});

test('simple commands are sent as the exact RetroArch command names', async () => {
  const ra = await fakeRetroArch('PLAYING');
  const c = createRetroArchClient({ port: ra.port, timeoutMs: 300 });
  await c.reset(); await c.loadState(); await c.closeContent(); await c.quit(); await c.showMessage('hi\nthere');
  await sleep(100);
  assert.deepEqual(ra.state.received, ['RESET', 'LOAD_STATE', 'CLOSE_CONTENT', 'QUIT', 'SHOW_MSG hi there']);
  ra.close();
});

test('saveState is confirmed by a fresh state file, and false when none appears', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
  const ra = await fakeRetroArch('PLAYING');
  const c = createRetroArchClient({ port: ra.port, statesDir: dir, timeoutMs: 300 });

  ra.state.onSave = () => fs.writeFileSync(path.join(dir, 'Demo Game A.state'), 'x');
  assert.equal(await c.saveState(800), true);

  fs.rmSync(path.join(dir, 'Demo Game A.state'));
  ra.state.onSave = null;                            // RetroArch "ignores" the command
  assert.equal(await c.saveState(400), false);

  ra.state.mode = 'CONTENTLESS';                     // nothing to save in the menu
  assert.equal(await c.saveState(400), false);
  ra.close();
});

test('an old state file does not count as a fresh save', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
  const old = path.join(dir, 'Demo Game A.state');
  fs.writeFileSync(old, 'old');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(old, past, past);
  const ra = await fakeRetroArch('PLAYING');
  const c = createRetroArchClient({ port: ra.port, statesDir: dir, timeoutMs: 300 });
  assert.equal(await c.saveState(400), false);
  ra.close();
});

// ── launch file ──────────────────────────────────────────────────────────────
test('launch file: writes CORE and ROM lines, paths with spaces intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const lf = createLaunchFile(dir);
  await lf.write('/cores/nes.so', '/roms/nes/Demo Game A.nes');
  assert.equal(fs.readFileSync(lf.file, 'utf8'), 'CORE=/cores/nes.so\nROM=/roms/nes/Demo Game A.nes\n');
});

test('launch file: empty values mean menu only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const lf = createLaunchFile(dir);
  await lf.write('', '');
  assert.equal(fs.readFileSync(lf.file, 'utf8'), 'CORE=\nROM=\n');
});

test('launch file: line breaks and null bytes are refused, and nothing is written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const lf = createLaunchFile(dir);
  await lf.write('/cores/a.so', '/roms/a.nes');
  await assert.rejects(lf.write('/cores/a.so', '/roms/x\nCORE=/evil.so'), /line break/);
  await assert.rejects(lf.write('/cores/a\r.so', '/roms/a.nes'), /line break/);
  await assert.rejects(lf.write('/cores/a.so', '/roms/a\0.nes'), /line break/);
  assert.equal(fs.readFileSync(lf.file, 'utf8'), 'CORE=/cores/a.so\nROM=/roms/a.nes\n', 'the old file must be untouched');
});

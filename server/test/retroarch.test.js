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
  const client = createRetroArchClient({ statusMode: 'udp', port: ra.port, timeoutMs: 300 });
  assert.equal((await client.status()).state, 'PLAYING');
  ra.close();
  const dead = createRetroArchClient({ statusMode: 'udp', port: ra.port, timeoutMs: 200 });
  assert.equal(await dead.status(), null);
});

test('pause and resume are idempotent even though the command is a toggle', async () => {
  const ra = await fakeRetroArch('PLAYING');
  const c = createRetroArchClient({ statusMode: 'udp', port: ra.port, timeoutMs: 300 });
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
  const c = createRetroArchClient({ statusMode: 'udp', port: ra.port, timeoutMs: 300 });
  await c.reset(); await c.loadState(); await c.closeContent(); await c.quit(); await c.showMessage('hi\nthere');
  await sleep(100);
  assert.deepEqual(ra.state.received, ['RESET', 'LOAD_STATE', 'CLOSE_CONTENT', 'QUIT', 'SHOW_MSG hi there']);
  ra.close();
});

test('saveState is confirmed by a fresh state file, and false when none appears', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
  const ra = await fakeRetroArch('PLAYING');
  const c = createRetroArchClient({ statusMode: 'udp', port: ra.port, statesDir: dir, timeoutMs: 300 });

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
  const c = createRetroArchClient({ statusMode: 'udp', port: ra.port, statesDir: dir, timeoutMs: 300 });
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

// ── status read from /proc (the method used on the real Pi) ──────────────────
const procFixture = (procs) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  for (const [pid, p] of Object.entries(procs)) {
    fs.mkdirSync(path.join(root, pid));
    fs.writeFileSync(path.join(root, pid, 'comm'), p.comm + '\n');
    fs.writeFileSync(path.join(root, pid, 'maps'), p.maps || '');
    fs.writeFileSync(path.join(root, pid, 'cmdline'), (p.args || []).join('\0') + '\0');
  }
  return root;
};
const CORE_MAP = '7f00-7f01 r-xp 0 00:00 0 /usr/lib/aarch64-linux-gnu/libretro/snes9x_libretro.so\n';

test('proc status: no retroarch process is null', async () => {
  const root = procFixture({ 100: { comm: 'bash' }, 200: { comm: 'node' } });
  const c = createRetroArchClient({ statusMode: 'proc', procRoot: root });
  assert.equal(await c.status(), null);
});

test('proc status: retroarch with no core is the menu', async () => {
  const root = procFixture({ 321: { comm: 'retroarch', maps: '7f-7f r-xp 0 0 0 /usr/lib/libc.so.6\n', args: ['retroarch', '--fullscreen'] } });
  const c = createRetroArchClient({ statusMode: 'proc', procRoot: root });
  assert.equal((await c.status()).state, 'CONTENTLESS');
});

test('proc status: a mapped core means playing, and the game name comes from the launch arguments', async () => {
  const args = ['retroarch', '--config', '/home/u/cfg.cfg', '-L', '/usr/lib/x/snes9x_libretro.so', '/home/u/roms/snes/Super Mario Kart (USA).sfc', '--fullscreen'];
  const root = procFixture({ 321: { comm: 'retroarch', maps: CORE_MAP, args } });
  const c = createRetroArchClient({ statusMode: 'proc', procRoot: root });
  const s = await c.status();
  assert.deepEqual(s, { state: 'PLAYING', system: 'snes9x', name: 'Super Mario Kart (USA).sfc' });
});

test('contentFromArgs ignores options and the values they take', () => {
  const { contentFromArgs } = require('../retroarch');
  assert.equal(contentFromArgs(['--config', 'a.cfg', '-L', 'core.so', 'game with spaces.sfc', '--fullscreen']), 'game with spaces.sfc');
  assert.equal(contentFromArgs(['--fullscreen', '--config', 'a.cfg']), null);
});

test('proc status: a paused game is remembered as paused, and a new game resets it', async () => {
  const dgramSock = dgram.createSocket('udp4');
  await new Promise((r) => dgramSock.bind(0, '127.0.0.1', r));
  const port = dgramSock.address().port;
  const received = [];
  dgramSock.on('message', (b) => received.push(b.toString()));
  const root = procFixture({ 7: { comm: 'retroarch', maps: CORE_MAP, args: ['retroarch', '-L', 'x/snes9x_libretro.so', 'one.sfc'] } });
  const c = createRetroArchClient({ port, statusMode: 'proc', procRoot: root });
  await c.pause(); await sleep(50);
  assert.equal((await c.status()).state, 'PAUSED');
  await c.pause(); await sleep(50);                       // already paused: no second toggle
  await c.resume(); await sleep(50);
  assert.deepEqual(received, ['PAUSE_TOGGLE', 'PAUSE_TOGGLE']);
  assert.equal((await c.status()).state, 'PLAYING');
  await c.pause();
  fs.writeFileSync(path.join(root, '7', 'cmdline'), ['retroarch', '-L', 'x/snes9x_libretro.so', 'two.sfc'].join('\0') + '\0');
  assert.equal((await c.status()).state, 'PLAYING', 'a different game must not start out paused');
  dgramSock.close();
});

test('saveState finds the state file in the per core folder RetroArch uses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
  fs.mkdirSync(path.join(dir, 'Snes9x'));
  const root = procFixture({ 7: { comm: 'retroarch', maps: CORE_MAP, args: ['retroarch', '-L', 'x/snes9x_libretro.so', '/r/Super Mario Kart (USA).sfc'] } });
  const ra = await fakeRetroArch('PLAYING');
  ra.state.onSave = () => fs.writeFileSync(path.join(dir, 'Snes9x', 'Super Mario Kart (USA).state'), 'x');
  const c = createRetroArchClient({ port: ra.port, statesDir: dir, statusMode: 'proc', procRoot: root });
  assert.equal(await c.saveState(800), true);
  ra.close();
});

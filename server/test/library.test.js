'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibrary, idFor } = require('../library');

const SYSTEMS = {
  nes:  { name: 'NES',  media: 'cartridge', dirs: ['nes'],  extensions: ['.nes', '.zip'], core: 'nes_libretro.so', biosRequired: false, bios: [], verified: false },
  snes: { name: 'SNES', media: 'cartridge', dirs: ['snes'], extensions: ['.sfc'],         core: 'snes_libretro.so', biosRequired: false, bios: [], verified: true },
  ps1:  { name: 'PS1',  media: 'disc',      dirs: ['ps1'],  extensions: ['.cue'],         core: 'ps1_libretro.so',  biosRequired: true,  bios: ['scph5501.bin'], verified: false },
  gba:  { name: 'GBA',  media: 'handheld',  dirs: ['gba'],  extensions: ['.gba'],         core: 'gba_libretro.so',  biosRequired: false, bios: [], verified: false },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const dirs = { roms: path.join(root, 'roms'), cores: path.join(root, 'cores'), bios: path.join(root, 'bios') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const put = (rel, body = 'x') => { const f = path.join(dirs.roms, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const core = (name) => fs.writeFileSync(path.join(dirs.cores, name), '');
  const lib = () => createLibrary({ romsDir: dirs.roms, coresDir: dirs.cores, biosDir: dirs.bios, systems: SYSTEMS });
  return { dirs, put, core, lib };
}

test('systems report ready, no_core, needs_bios and empty', () => {
  const f = fixture();
  f.put('nes/Game A.nes'); f.core('nes_libretro.so');           // ready
  f.put('snes/Game B.sfc');                                     // no core
  f.put('ps1/Disc.cue'); f.core('ps1_libretro.so');             // core but no BIOS
  f.core('gba_libretro.so');                                    // core, no games
  const by = Object.fromEntries(f.lib().systems().map((s) => [s.id, s]));
  assert.equal(by.nes.ready, 'ready');
  assert.equal(by.snes.ready, 'no_core');
  assert.equal(by.ps1.ready, 'needs_bios');
  assert.equal(by.gba.ready, 'empty');
  assert.equal(by.nes.games, 1);
  assert.equal(by.snes.verified, true, 'the verified flag comes from the config');
});

test('a BIOS file makes a BIOS system ready', () => {
  const f = fixture();
  f.put('ps1/Disc.cue'); f.core('ps1_libretro.so');
  fs.writeFileSync(path.join(f.dirs.bios, 'scph5501.bin'), '');
  assert.equal(f.lib().systems().find((s) => s.id === 'ps1').ready, 'ready');
});

test('list returns games sorted, with names that keep spaces and apostrophes, and no paths', () => {
  const f = fixture(); f.core('nes_libretro.so');
  f.put("nes/Alice's Quest.nes"); f.put('nes/zelda demo.nes'); f.put('nes/Bravo.nes');
  const r = f.lib().list('nes');
  assert.deepEqual(r.items.map((g) => g.name), ["Alice's Quest", 'Bravo', 'zelda demo']);
  assert.equal(r.total, 3);
  for (const g of r.items) {
    assert.deepEqual(Object.keys(g).sort(), ['id', 'name', 'sizeMB', 'system']);
  }
});

test('only the listed extensions count, hidden files are ignored, case does not matter', () => {
  const f = fixture(); f.core('nes_libretro.so');
  f.put('nes/A.nes'); f.put('nes/B.NES'); f.put('nes/notes.txt'); f.put('nes/.hidden.nes'); f.put('nes/C.bin');
  assert.deepEqual(f.lib().list('nes').items.map((g) => g.name), ['A', 'B']);
});

test('games one folder down are found, deeper ones are not', () => {
  const f = fixture(); f.core('nes_libretro.so');
  f.put('nes/Folder Game/Folder Game.nes'); f.put('nes/a/b/c/Too Deep.nes');
  assert.deepEqual(f.lib().list('nes').items.map((g) => g.name), ['Folder Game']);
});

test('paging: pages are consistent and the size is capped', () => {
  const f = fixture(); f.core('nes_libretro.so');
  for (let i = 0; i < 25; i++) f.put(`nes/Game ${String(i).padStart(2, '0')}.nes`);
  const lib = f.lib();
  const p0 = lib.list('nes', 0, 10), p1 = lib.list('nes', 1, 10), p2 = lib.list('nes', 2, 10);
  assert.equal(p0.items.length, 10); assert.equal(p1.items.length, 10); assert.equal(p2.items.length, 5);
  assert.equal(p0.total, 25);
  const all = [...p0.items, ...p1.items, ...p2.items].map((g) => g.id);
  assert.equal(new Set(all).size, 25, 'no game appears twice');
  assert.equal(lib.list('nes', 0, 5000).size, 100, 'page size is capped at 100');
  assert.equal(lib.list('nes', -3, -1).page, 0, 'bad numbers fall back to safe values');
});

test('ids are stable across scans and differ between systems', () => {
  const f = fixture(); f.core('nes_libretro.so');
  f.put('nes/Same Name.nes'); f.put('snes/Same Name.sfc');
  const a = f.lib().list('nes').items[0].id;
  const b = f.lib().list('nes').items[0].id;
  assert.equal(a, b);
  assert.equal(a, idFor('nes', 'nes/Same Name.nes'));
  assert.notEqual(a, f.lib().list('snes').items[0].id);
});

test('new files appear without restarting', () => {
  const f = fixture(); f.core('nes_libretro.so');
  f.put('nes/One.nes');
  const lib = f.lib();
  assert.equal(lib.list('nes').total, 1);
  const later = new Date(Date.now() + 2000);
  f.put('nes/Two.nes'); fs.utimesSync(path.join(f.dirs.roms, 'nes'), later, later); // make the folder change visible
  assert.equal(lib.list('nes').total, 2);
});

// ── resolve: the security boundary ───────────────────────────────────────────
test('resolve turns an id into the core and rom paths', () => {
  const f = fixture(); f.core('nes_libretro.so'); const rom = f.put('nes/Game A.nes');
  const lib = f.lib();
  const id = lib.list('nes').items[0].id;
  const r = lib.resolve(id);
  assert.equal(r.rom, rom);
  assert.equal(r.core, path.join(f.dirs.cores, 'nes_libretro.so'));
  assert.equal(r.system, 'nes');
});

test('resolve works on a fresh library object (a new server process)', () => {
  const f = fixture(); f.core('nes_libretro.so'); f.put('nes/Game A.nes');
  const id = f.lib().list('nes').items[0].id;
  assert.ok(f.lib().resolve(id));
});

test('resolve rejects every hostile or malformed id and never returns a path', () => {
  const f = fixture(); f.core('nes_libretro.so'); f.put('nes/Game A.nes');
  const lib = f.lib(); lib.list('nes');
  const bad = [
    '../../etc/passwd', '..\\..\\windows\\system32', '/etc/passwd', 'nes:../../../etc/passwd',
    'nes:zzzzzzzzzzzz', 'nes:', ':abcdef123456', 'unknown:abcdef123456', '__proto__:abcdef123456',
    'constructor:abcdef123456', 'nes:abcdef123456; rm -rf /', 'nes:abcdef123456\nCORE=/evil',
    '', null, undefined, 42, {}, ['nes:abcdef123456'], 'NES:ABCDEF123456',
  ];
  for (const id of bad) assert.equal(lib.resolve(id), null, 'should reject ' + JSON.stringify(id));
});

test('resolve refuses a game whose file was deleted', () => {
  const f = fixture(); f.core('nes_libretro.so'); const rom = f.put('nes/Gone.nes');
  const lib = f.lib(); const id = lib.list('nes').items[0].id;
  fs.rmSync(rom);
  assert.equal(lib.resolve(id), null);
});

test('resolve refuses a game whose system has no core, and says why', () => {
  const f = fixture(); f.put('snes/Game B.sfc');
  const lib = f.lib(); const id = lib.list('snes').items[0].id;
  assert.equal(lib.resolve(id), null);
  assert.equal(lib.whyNot(id), 'no_core');
});

test('resolve refuses a BIOS system without a BIOS, and says why', () => {
  const f = fixture(); f.core('ps1_libretro.so'); f.put('ps1/Disc.cue');
  const lib = f.lib(); const id = lib.list('ps1').items[0].id;
  assert.equal(lib.resolve(id), null);
  assert.equal(lib.whyNot(id), 'needs_bios');
});

test('list of an unknown system, or a prototype key, is null', () => {
  const f = fixture(); const lib = f.lib();
  for (const s of ['nope', '__proto__', 'constructor', 'toString', '', null]) assert.equal(lib.list(s), null);
});

test('a symlink pointing outside the games folder is not launchable', (t) => {
  const f = fixture(); f.core('nes_libretro.so');
  const outside = path.join(os.tmpdir(), 'outside-' + Date.now() + '.nes');
  fs.writeFileSync(outside, 'secret');
  fs.mkdirSync(path.join(f.dirs.roms, 'nes'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(f.dirs.roms, 'nes', 'Escape.nes'));
  } catch {
    t.skip('this system cannot create symlinks without extra privileges');
    return;
  }
  const lib = f.lib();
  const item = lib.list('nes').items.find((g) => g.name === 'Escape');
  assert.ok(item, 'the link is listed');
  assert.equal(lib.resolve(item.id), null, 'but it must not resolve');
});

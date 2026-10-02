'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModeManager, ModeError } = require('../mode');

const VIDEO = 'video-mode';
const GAME = 'game-mode';
const other = (u) => (u === VIDEO ? GAME : VIDEO);
const quiet = { warn() {}, error() {}, log() {} };

// A fake Pi: two units that exclude each other, a fake RetroArch and fake VLC,
// each with switches to force failures.
class World {
  constructor() {
    this.active = new Set([VIDEO]);
    this.launch = { core: '', rom: '' };
    this.failStart = new Set();   // units whose start never takes effect
    this.videoFailures = 0;       // how many video starts fail before one works
    this.log = [];
    this.suspended = false;
    this.restoredWith = [];

    this.units = {
      start: async (u) => {
        this.log.push('start ' + u);
        this.active.delete(other(u));           // Conflicts=
        if (u === VIDEO && this.videoFailures > 0) { this.videoFailures -= 1; return; }
        if (this.failStart.has(u)) return;
        this.active.add(u);
      },
      stop: async (u) => { this.log.push('stop ' + u); this.active.delete(u); },
      restart: async (u) => { this.active.delete(u); await this.units.start(u); },
      isActive: async (u) => this.active.has(u),
    };
    this.retroarch = {
      status: async () => {
        if (!this.active.has(GAME)) return null;
        if (!this.launch.rom) return { state: 'CONTENTLESS' };
        return { state: 'PLAYING', system: 'nes', name: this.launch.rom.split('/').pop() };
      },
    };
    this.video = {
      snapshot: async () => ({ nowPlaying: 'movie.mp4', pos: 42, upNext: ['next.mp4'], history: [] }),
      restore: async (snap) => { this.restoredWith.push(snap); },
      suspend: () => { this.suspended = true; },
      resume: () => { this.suspended = false; },
      ping: async () => this.active.has(VIDEO),
    };
    this.launchFile = { write: async (core, rom) => { this.launch = { core, rom }; } };
  }

  manager() {
    return new ModeManager({
      units: this.units, retroarch: this.retroarch, video: this.video, launchFile: this.launchFile,
      config: { gameReadyMs: 300, launchMs: 400, videoReadyMs: 300, pollMs: 5, errorRetryMs: 20 },
      log: quiet,
    });
  }
}

const game = { id: 'nes:abc', name: 'Demo Game A', system: 'nes', core: '/cores/nes.so', rom: '/roms/nes/Demo Game A.nes' };

// ── init: work out the real mode at boot ─────────────────────────────────────
test('init adopts Video Mode when only VLC is running', async () => {
  const w = new World(); const m = w.manager();
  const s = await m.init();
  assert.equal(s.mode, 'video');
});

test('init starts Video Mode when nothing is running', async () => {
  const w = new World(); w.active.clear(); const m = w.manager();
  const s = await m.init();
  assert.equal(s.mode, 'video');
  assert.ok(w.active.has(VIDEO));
});

test('init adopts a running game instead of killing it', async () => {
  const w = new World(); w.active = new Set([GAME]); w.launch = { core: 'c', rom: '/roms/nes/Demo Game A.nes' };
  const m = w.manager();
  const s = await m.init();
  assert.equal(s.mode, 'game');
  assert.equal(s.phase, 'playing');
  assert.equal(s.game.name, 'Demo Game A.nes');
  assert.ok(w.active.has(GAME), 'the game must still be running');
});

test('init adopts the game menu when RetroArch has no content', async () => {
  const w = new World(); w.active = new Set([GAME]); const m = w.manager();
  const s = await m.init();
  assert.equal(s.mode, 'game'); assert.equal(s.phase, 'menu');
});

test('init fixes the impossible both running case toward Video Mode', async () => {
  const w = new World(); w.active = new Set([VIDEO, GAME]); const m = w.manager();
  const s = await m.init();
  assert.equal(s.mode, 'video');
  assert.ok(!w.active.has(GAME));
});

// ── switching to Game Mode ───────────────────────────────────────────────────
test('switch to game: video saved and suspended, game menu up, VLC stopped', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  const s = await m.switchTo('game');
  assert.equal(s.mode, 'game'); assert.equal(s.phase, 'menu');
  assert.ok(w.active.has(GAME) && !w.active.has(VIDEO));
  assert.equal(w.suspended, true, 'the queue watcher must be paused while in game mode');
});

test('switch to game failing rolls back to Video Mode and restores the video', async () => {
  const w = new World(); w.failStart.add(GAME); const m = w.manager(); await m.init();
  await assert.rejects(m.switchTo('game'), (e) => e instanceof ModeError && e.code === 'switch_failed');
  const s = m.getState();
  assert.equal(s.mode, 'video');
  assert.ok(w.active.has(VIDEO));
  assert.equal(w.restoredWith.length, 1);
  assert.equal(w.restoredWith[0].nowPlaying, 'movie.mp4');
  assert.equal(w.restoredWith[0].pos, 42);
  assert.equal(w.suspended, false);
});

test('a second switch during a switch is refused as busy', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  const first = m.switchTo('game');
  await assert.rejects(m.switchTo('game'), (e) => e.code === 'busy');
  await first;
});

test('switching to the mode you are already in changes nothing', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  const before = w.log.length;
  const s = await m.switchTo('video');
  assert.equal(s.mode, 'video');
  assert.equal(w.log.length, before);
});

test('invalid target is rejected', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  await assert.rejects(m.switchTo('tv'), (e) => e.code === 'invalid_target');
});

// ── leaving Game Mode ────────────────────────────────────────────────────────
test('leaving a playing game needs confirmation, then resumes the video exactly', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  await m.switchTo('game'); await m.launch(game);
  await assert.rejects(m.switchTo('video'), (e) => e.code === 'confirm_required');
  assert.equal(m.getState().mode, 'game', 'a refused switch must not change anything');
  const s = await m.switchTo('video', { force: true });
  assert.equal(s.mode, 'video');
  assert.ok(w.active.has(VIDEO) && !w.active.has(GAME));
  assert.equal(w.restoredWith.at(-1).pos, 42);
  assert.equal(w.suspended, false);
});

test('leaving the menu needs no confirmation', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  await m.switchTo('game');
  const s = await m.switchTo('video');
  assert.equal(s.mode, 'video');
});

test('video failing to start twice enters error, and polling recovers it', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  await m.switchTo('game');
  w.videoFailures = 2;
  const s = await m.switchTo('video');
  assert.equal(s.mode, 'error');
  await new Promise((r) => setTimeout(r, 40));
  await m.poll();
  assert.equal(m.getState().mode, 'video');
  assert.ok(w.active.has(VIDEO));
});

test('from error, going to game is refused', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  await m.switchTo('game'); w.videoFailures = 5; await m.switchTo('video');
  await assert.rejects(m.switchTo('game'), (e) => e.code === 'invalid_state');
});

// ── launching games ──────────────────────────────────────────────────────────
test('launch writes what to run and reaches playing', async () => {
  const w = new World(); const m = w.manager(); await m.init(); await m.switchTo('game');
  const phases = []; m.on('change', (s) => phases.push(s.phase));
  const s = await m.launch(game);
  assert.equal(s.phase, 'playing');
  assert.deepEqual(s.game, { id: 'nes:abc', name: 'Demo Game A', system: 'nes' });
  assert.deepEqual(w.launch, { core: game.core, rom: game.rom });
  assert.ok(phases.includes('launching'), 'the launching phase must be visible');
});

test('launch in Video Mode is refused', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  await assert.rejects(m.launch(game), (e) => e.code === 'not_in_mode');
});

test('a game that fails to start returns to the menu with launch_failed', async () => {
  const w = new World(); const m = w.manager(); await m.init(); await m.switchTo('game');
  // After the restart the game unit dies (a bad ROM or core).
  const realRestart = w.units.restart;
  w.units.restart = async (u) => { if (w.launch.rom) { w.active.delete(u); return; } return realRestart(u); };
  await assert.rejects(m.launch(game), (e) => e.code === 'launch_failed');
  const s = m.getState();
  assert.equal(s.mode, 'game'); assert.equal(s.phase, 'menu'); assert.equal(s.game, null);
});

test('if even the menu will not come back, launch failure falls back to Video Mode', async () => {
  const w = new World(); const m = w.manager(); await m.init(); await m.switchTo('game');
  w.failStart.add(GAME);
  w.units.restart = async (u) => { w.active.delete(u); await w.units.start(u); };
  await assert.rejects(m.launch(game), (e) => e.code === 'launch_failed');
  assert.equal(m.getState().mode, 'video');
  assert.ok(w.active.has(VIDEO));
});

test('quit to menu restarts with no content', async () => {
  const w = new World(); const m = w.manager(); await m.init(); await m.switchTo('game'); await m.launch(game);
  const s = await m.quitToMenu();
  assert.equal(s.phase, 'menu'); assert.equal(s.game, null);
  assert.equal(w.launch.rom, '');
});

// ── poll: things that happen on their own ────────────────────────────────────
test('poll: the game process vanishing returns to Video Mode with a notice and the video restored', async () => {
  const w = new World(); const m = w.manager(); await m.init(); await m.switchTo('game'); await m.launch(game);
  const notices = []; m.on('notice', (n) => notices.push(n.code));
  w.active.delete(GAME); // RetroArch crashed
  await m.poll();
  assert.equal(m.getState().mode, 'video');
  assert.ok(notices.includes('game_exited'));
  assert.equal(w.restoredWith.at(-1).nowPlaying, 'movie.mp4');
});

test('poll: a guest closing the game with the hotkey moves the phase to menu', async () => {
  const w = new World(); const m = w.manager(); await m.init(); await m.switchTo('game'); await m.launch(game);
  w.launch = { core: '', rom: '' }; // RetroArch is now contentless but still running
  await m.poll();
  assert.equal(m.getState().phase, 'menu');
  assert.equal(m.getState().game, null);
});

test('poll: VLC dying in Video Mode is restarted and reported', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  const notices = []; m.on('notice', (n) => notices.push(n.code));
  w.active.delete(VIDEO);
  await m.poll();
  assert.ok(w.active.has(VIDEO));
  assert.ok(notices.includes('video_restarted'));
});

test('poll does nothing while a switch is in progress', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  const sw = m.switchTo('game');
  const before = w.log.length;
  await m.poll();
  assert.equal(w.log.length, before);
  await sw;
});

test('change events fire for every state change', async () => {
  const w = new World(); const m = w.manager(); await m.init();
  const modes = []; m.on('change', (s) => modes.push(s.mode));
  await m.switchTo('game');
  assert.deepEqual(modes, ['switching', 'game']);
});

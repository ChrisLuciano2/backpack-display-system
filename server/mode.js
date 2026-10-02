// server/mode.js
// The mode state machine: which of Video Mode or Game Mode the Pi is in, and how
// it moves between them safely.
//
// The Pi owns the mode. The phone only displays it. Every path that can fail ends
// somewhere known: a failed switch to Game Mode rolls back to Video Mode, and a
// failed return to Video Mode keeps retrying. The Pi never sits on a black screen
// with nobody trying to fix it.
//
// State:  { mode, target, phase, game, error }
//   mode   'video' | 'game' | 'switching' | 'error'
//   target 'video' | 'game' while switching, else null
//   phase  in game mode: 'menu' | 'launching' | 'playing', else null
//   game   { id, name, system } while launching or playing, else null
//
// Everything outside the state machine is injected, so it is fully testable:
//   units       { start, stop, restart, isActive }       systemd services
//   retroarch   { status() }                             null when unreachable
//   video       { snapshot, restore, suspend, resume, ping }
//   launchFile  { write(core, rom) }                     what to launch next

'use strict';

const { EventEmitter } = require('events');

const VIDEO_UNIT = 'video-mode';
const GAME_UNIT = 'game-mode';

class ModeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ModeManager extends EventEmitter {
  constructor({ units, retroarch, video, launchFile, config = {}, sleep = defaultSleep, log = console }) {
    super();
    this.units = units;
    this.ra = retroarch;
    this.video = video;
    this.launchFile = launchFile;
    this.sleep = sleep;
    this.log = log;
    this.cfg = Object.assign({
      gameReadyMs: 8000,     // RetroArch must answer within this after start
      launchMs: 15000,       // a game must be running within this after launch
      videoReadyMs: 8000,    // VLC must answer within this after start
      pollMs: 100,           // spacing inside wait loops
      errorRetryMs: 5000,    // spacing between retries while in error
    }, config);

    this.state = { mode: 'video', target: null, phase: null, game: null, error: null };
    this._busy = false;
    this._snapshot = null;       // video state saved when leaving Video Mode
    this._lastErrorTry = 0;
    this._timer = null;
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.emit('change', this.getState());
  }

  _notice(code, message) {
    this.log.warn && this.log.warn(`[mode] ${code}: ${message}`);
    this.emit('notice', { code, message });
  }

  // ── Boot: work out the real mode from what is actually running ──────────────
  async init() {
    const [video, game] = await Promise.all([this.units.isActive(VIDEO_UNIT), this.units.isActive(GAME_UNIT)]);
    if (video && !game) {
      this._set({ mode: 'video', target: null, phase: null, game: null });
    } else if (!video && game) {
      // Node restarted while a game was running: adopt it, do not kill a guest's game.
      const s = await this.ra.status();
      const playing = !!(s && s.state && s.state !== 'CONTENTLESS');
      this._set({
        mode: 'game', target: null,
        phase: playing ? 'playing' : 'menu',
        game: playing ? { id: null, name: s.name || null, system: s.system || null } : null,
      });
    } else if (!video && !game) {
      await this._startVideoAndRestore();
      this._set({ mode: 'video', target: null, phase: null, game: null });
    } else {
      // Both running should be impossible (Conflicts=). Fix it toward Video Mode.
      this._notice('both_running', 'Both modes were running. Stopped Game Mode.');
      await this.units.stop(GAME_UNIT);
      this._set({ mode: 'video', target: null, phase: null, game: null });
    }
    return this.getState();
  }

  // ── Switching modes ─────────────────────────────────────────────────────────
  async switchTo(target, opts = {}) {
    if (target !== 'video' && target !== 'game') throw new ModeError('invalid_target', 'mode must be video or game');
    if (this._busy || this.state.mode === 'switching') {
      throw new ModeError('busy', 'The Pi is switching modes. Try again in a few seconds.');
    }
    const { mode, phase } = this.state;
    if (mode === target) return this.getState();
    if (mode === 'error' && target === 'game') {
      throw new ModeError('invalid_state', 'Video Mode is recovering. Try again in a moment.');
    }
    if (target === 'video' && mode === 'game' && phase === 'playing' && !opts.force) {
      throw new ModeError('confirm_required', 'A game is running. Confirm to leave it.');
    }
    this._busy = true;
    try {
      return target === 'game' ? await this._toGame() : await this._toVideo();
    } finally {
      this._busy = false;
    }
  }

  async _toGame() {
    this._set({ mode: 'switching', target: 'game' });
    try {
      // Remember what was playing so Video Mode can resume exactly there.
      try {
        this._snapshot = await this.video.snapshot();
      } catch (err) {
        this.log.warn && this.log.warn('[mode] could not snapshot video state: ' + err.message);
        this._snapshot = null;
      }
      this.video.suspend();
      await this.launchFile.write('', '');
      await this.units.start(GAME_UNIT); // Conflicts= stops VLC
      const up = await this._waitFor(() => this.ra.status().then((s) => s !== null), this.cfg.gameReadyMs, GAME_UNIT);
      if (!up) throw new Error('RetroArch did not respond in time');
      this._set({ mode: 'game', target: null, phase: 'menu', game: null });
      return this.getState();
    } catch (err) {
      this.log.warn && this.log.warn('[mode] switch to game failed: ' + err.message);
      await this._rollbackToVideo();
      throw new ModeError('switch_failed', 'Game Mode did not start. Back in Video Mode.');
    }
  }

  async _toVideo() {
    this._set({ mode: 'switching', target: 'video' });
    return this._returnToVideo();
  }

  // Get back to Video Mode, retrying once, and never give up: on repeated failure
  // enter the error state, and poll() keeps retrying.
  async _returnToVideo() {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this._startVideoAndRestore();
        this._set({ mode: 'video', target: null, phase: null, game: null, error: null });
        return this.getState();
      } catch (err) {
        this.log.warn && this.log.warn(`[mode] video start attempt ${attempt} failed: ${err.message}`);
      }
    }
    this._lastErrorTry = Date.now();
    this._set({ mode: 'error', target: null, phase: null, game: null, error: 'Video Mode did not start. Retrying.' });
    this._notice('video_failed', 'Video Mode did not start. Retrying.');
    return this.getState();
  }

  async _rollbackToVideo() {
    this._set({ mode: 'switching', target: 'video', phase: null, game: null });
    await this._returnToVideo();
  }

  async _startVideoAndRestore() {
    await this.units.start(VIDEO_UNIT); // Conflicts= stops RetroArch
    const up = await this._waitFor(() => this.video.ping(), this.cfg.videoReadyMs, VIDEO_UNIT);
    if (!up) throw new Error('VLC did not respond in time');
    if (this._snapshot) {
      try {
        await this.video.restore(this._snapshot);
      } catch (err) {
        this.log.warn && this.log.warn('[mode] could not restore video state: ' + err.message);
      }
    }
    this._snapshot = null;
    this.video.resume();
  }

  // ── Games ───────────────────────────────────────────────────────────────────
  // game: { id, name, system, core, rom }. The library has already resolved the
  // id to a real path, this module never sees a raw path from the phone.
  async launch(game) {
    if (this.state.mode !== 'game') throw new ModeError('not_in_mode', 'Switch to Game Mode first.');
    if (this._busy) throw new ModeError('busy', 'The Pi is busy. Try again in a few seconds.');
    this._busy = true;
    try {
      this._set({ phase: 'launching', game: { id: game.id, name: game.name, system: game.system } });
      try {
        await this.launchFile.write(game.core, game.rom);
        await this.units.restart(GAME_UNIT);
        const running = await this._waitFor(async () => {
          const s = await this.ra.status();
          return !!(s && s.state && s.state !== 'CONTENTLESS');
        }, this.cfg.launchMs, GAME_UNIT);
        if (!running) throw new Error('game did not start');
        this._set({ phase: 'playing' });
        return this.getState();
      } catch (err) {
        this.log.warn && this.log.warn('[mode] launch failed: ' + err.message);
        await this._recoverToMenu();
        throw new ModeError('launch_failed', 'That game did not start.');
      }
    } finally {
      this._busy = false;
    }
  }

  // Leave the running game and show the game list again.
  async quitToMenu() {
    if (this.state.mode !== 'game') throw new ModeError('not_in_mode', 'No game is running.');
    if (this._busy) throw new ModeError('busy', 'The Pi is busy. Try again in a few seconds.');
    this._busy = true;
    try {
      await this._recoverToMenu();
      return this.getState();
    } finally {
      this._busy = false;
    }
  }

  // Restart RetroArch with no content. If even that fails, fall all the way back
  // to Video Mode instead of leaving a broken Game Mode.
  async _recoverToMenu() {
    try {
      await this.launchFile.write('', '');
      await this.units.restart(GAME_UNIT);
      const up = await this._waitFor(() => this.ra.status().then((s) => s !== null), this.cfg.gameReadyMs, GAME_UNIT);
      if (!up) throw new Error('menu did not come up');
      this._set({ mode: 'game', phase: 'menu', game: null });
    } catch (err) {
      this.log.warn && this.log.warn('[mode] could not return to the game menu: ' + err.message);
      await this._rollbackToVideo();
    }
  }

  // ── Watching for things going wrong or changing on their own ────────────────
  // Called on a timer while the server runs. Never throws.
  async poll() {
    if (this._busy || this.state.mode === 'switching') return;
    try {
      const { mode, phase } = this.state;
      if (mode === 'game') {
        if (!(await this.units.isActive(GAME_UNIT))) {
          this._busy = true;
          try {
            this._notice('game_exited', 'The game closed unexpectedly. Back in Video Mode.');
            this._set({ mode: 'switching', target: 'video', phase: null, game: null });
            await this._returnToVideo();
          } finally {
            this._busy = false;
          }
          return;
        }
        const s = await this.ra.status();
        if (s && phase !== 'launching') {
          const playing = !!(s.state && s.state !== 'CONTENTLESS');
          if (playing && phase !== 'playing') this._set({ phase: 'playing' });
          if (!playing && phase !== 'menu') this._set({ phase: 'menu', game: null }); // e.g. the guest hotkey closed the game
        }
      } else if (mode === 'video') {
        if (!(await this.units.isActive(VIDEO_UNIT))) {
          this._busy = true;
          try {
            await this._startVideoAndRestore();
            this._notice('video_restarted', 'Video player restarted and resumed.');
          } catch (err) {
            this.log.warn && this.log.warn('[mode] video restart failed: ' + err.message);
          } finally {
            this._busy = false;
          }
        }
      } else if (mode === 'error') {
        if (Date.now() - this._lastErrorTry >= this.cfg.errorRetryMs) {
          this._lastErrorTry = Date.now();
          this._busy = true;
          try {
            await this._startVideoAndRestore();
            this._set({ mode: 'video', target: null, phase: null, game: null, error: null });
            this._notice('video_restarted', 'Video Mode recovered.');
          } catch (err) {
            this.log.warn && this.log.warn('[mode] recovery attempt failed: ' + err.message);
          } finally {
            this._busy = false;
          }
        }
      }
    } catch (err) {
      this.log.warn && this.log.warn('[mode] poll error: ' + err.message);
    }
  }

  start(intervalMs = 1000) {
    if (this._timer) return;
    this._timer = setInterval(() => this.poll(), intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // Wait until pred() is true. Gives up early if the unit stops running, so a
  // program that crashed on start fails fast instead of waiting out the timeout.
  async _waitFor(pred, ms, unit) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (unit && !(await this.units.isActive(unit))) return false;
      try {
        if (await pred()) return true;
      } catch { /* not ready yet */ }
      await this.sleep(this.cfg.pollMs);
    }
    return false;
  }
}

module.exports = { ModeManager, ModeError, VIDEO_UNIT, GAME_UNIT };

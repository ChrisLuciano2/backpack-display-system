// Mode switching end to end in the virtual Pi: the real ModeManager, real units
// (through the fake systemctl), real launch file and RetroArch client (against the
// fake RetroArch) and real VLC. Only the emulator itself is fake.
'use strict';

const path = require('path');
const APP = '/app/server';
const { ModeManager, ModeError } = require(path.join(APP, 'mode'));
const units = require(path.join(APP, 'units'));
const vlc = require(path.join(APP, 'vlc'));
const { createLaunchFile } = require(path.join(APP, 'launchFile'));
const { createRetroArchClient } = require(path.join(APP, 'retroarch'));
const fs = require('fs');

const HOME = process.env.HOME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok, name, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures += 1;
}

// A minimal stand in for the queue state that index.js will provide in step 5.
let nowPlaying = null;
const video = {
  async snapshot() { const s = await vlc.rawStatus(); return { nowPlaying, pos: s.time || 0, wasPlaying: s.state === 'playing' }; },
  suspend() {}, resume() {},
  async ping() { try { const s = await vlc.rawStatus(); return !!s.state; } catch { return false; } },
  async restore(snap) {
    if (!snap.nowPlaying) return;
    await vlc.playFile('/media/' + snap.nowPlaying);
    await sleep(900);
    await vlc.seek(snap.pos);
  },
};

const ra = createRetroArchClient({ statesDir: HOME + '/states' });
const mgr = new ModeManager({
  units, retroarch: ra, video, launchFile: createLaunchFile(),
  config: { pollMs: 100 },
  log: { warn: (m) => console.log('  [mode] ' + m) },
});
const notices = [];
mgr.on('notice', (n) => notices.push(n.code));

const gameInfo = { id: 'nes:1', name: 'Demo Game A', system: 'nes', core: HOME + '/cores/nestopia_libretro.so', rom: HOME + '/roms/nes/Demo Game A.nes' };

async function vlcStatus() { try { return await vlc.rawStatus(); } catch { return null; } }

(async () => {
  // 1. Boot
  let s = await mgr.init();
  check(s.mode === 'video', 'boot: the Pi is in Video Mode', JSON.stringify(s));

  // 2. Something is playing, part way through
  nowPlaying = 'long clip.mp4';
  await vlc.playFile('/media/long clip.mp4');
  await sleep(1000);
  await vlc.seek(20);
  await sleep(1200);
  const before = await vlcStatus();
  check(before && before.state === 'playing', 'a video is playing before the switch', JSON.stringify(before));

  // 3. Video to game
  const t0 = Date.now();
  s = await mgr.switchTo('game');
  const switchMs = Date.now() - t0;
  check(s.mode === 'game' && s.phase === 'menu', 'switch to game reaches the game menu', JSON.stringify(s));
  check(switchMs < 10000, 'switch to game takes under 10 s (' + switchMs + ' ms)', switchMs + ' ms');
  check((await vlcStatus()) === null, 'VLC is gone while in Game Mode', 'VLC still answering');
  check((await ra.status()).state === 'CONTENTLESS', 'RetroArch is up with no content', '');

  // 4. Launch a game
  s = await mgr.launch(gameInfo);
  check(s.phase === 'playing' && s.game.name === 'Demo Game A', 'launch reaches playing', JSON.stringify(s));
  const raStatus = await ra.status();
  check(raStatus && raStatus.state === 'PLAYING' && raStatus.name === 'Demo Game A.nes', 'RetroArch reports the game with a space in its name', JSON.stringify(raStatus));

  // 5. In game controls
  await ra.pause(); await sleep(200);
  check((await ra.status()).state === 'PAUSED', 'pause works', '');
  await ra.resume(); await sleep(200);
  check((await ra.status()).state === 'PLAYING', 'resume works', '');
  check((await ra.saveState(2000)) === true, 'save state is confirmed by a fresh file', '');

  // 6. Leaving needs confirmation, then the video resumes at its position
  let refused = null;
  try { await mgr.switchTo('video'); } catch (e) { refused = e; }
  check(refused instanceof ModeError && refused.code === 'confirm_required', 'leaving a playing game is refused without force', String(refused));
  check(mgr.getState().mode === 'game', 'the refused switch changed nothing', '');
  const t1 = Date.now();
  s = await mgr.switchTo('video', { force: true });
  const backMs = Date.now() - t1;
  check(s.mode === 'video', 'switch back to video works', JSON.stringify(s));
  check(backMs < 10000, 'switch back takes under 10 s (' + backMs + ' ms)', backMs + ' ms');
  check(fs.existsSync(HOME + '/states/Demo Game A.nes.state.auto'), 'leaving a game autosaved it', 'no autosave file');
  await sleep(1500);
  const after = await vlcStatus();
  check(after && after.state === 'playing' && after.information.category.meta.filename === 'long clip.mp4', 'the same video is playing again', JSON.stringify(after && after.information && after.information.category));
  check(after && after.time >= 18 && after.time <= 32, 'video resumed near where it was (was ~21 s, now ' + (after && after.time) + ' s)', String(after && after.time));

  // 7. Fault: RetroArch fails to start. Must roll back to video by itself.
  process.env.SIM_FAIL = 'start';
  const t2 = Date.now();
  let failErr = null;
  try { await mgr.switchTo('game'); } catch (e) { failErr = e; }
  const failMs = Date.now() - t2;
  delete process.env.SIM_FAIL;
  check(failErr && failErr.code === 'switch_failed', 'a failed start reports switch_failed', String(failErr));
  check(mgr.getState().mode === 'video', 'after the failure the Pi is back in Video Mode', JSON.stringify(mgr.getState()));
  check(failMs < 10000, 'the failure is handled in under 10 s (' + failMs + ' ms)', failMs + ' ms');
  await sleep(1500);
  const rolled = await vlcStatus();
  check(rolled && rolled.state === 'playing', 'the video is playing again after the rollback', JSON.stringify(rolled));

  // 8. Fault: RetroArch crashes while a guest is playing
  await mgr.switchTo('game');
  process.env.SIM_CRASH_AFTER_MS = '1500';
  await mgr.launch(gameInfo);
  delete process.env.SIM_CRASH_AFTER_MS;
  await sleep(2200);              // the fake crashes
  await mgr.poll();
  check(mgr.getState().mode === 'video', 'a crashed game returns the Pi to Video Mode', JSON.stringify(mgr.getState()));
  check(notices.includes('game_exited'), 'the crash is reported as game_exited', JSON.stringify(notices));

  // 9. Recovery: a fresh Node process finds a running game and adopts it
  await mgr.switchTo('game');
  await mgr.launch(gameInfo);
  const fresh = new ModeManager({ units, retroarch: ra, video, launchFile: createLaunchFile(), log: { warn() {} } });
  s = await fresh.init();
  check(s.mode === 'game' && s.phase === 'playing', 'a restarted server adopts the running game', JSON.stringify(s));
  check((await ra.status()).state === 'PLAYING', 'the game was not killed by the restart', '');
  await mgr.switchTo('video', { force: true });

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('scenario crashed:', e); process.exit(2); });

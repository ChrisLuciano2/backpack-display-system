// Checks the virtual Pi itself: the fake systemctl units, the real launch scripts,
// and the fake RetroArch's command port. If these fail, later results mean nothing.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');

const HOME = process.env.HOME;
const STATE = HOME + '/.local/state/backpack';
let failures = 0;
function check(ok, name, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });
const active = (u) => ctl('is-active', u).stdout.trim() === 'active';

function udp(cmd, waitReply = true) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => { s.close(); resolve(null); }, 800);
    s.on('message', (m) => { clearTimeout(timer); s.close(); resolve(m.toString()); });
    s.send(cmd, 55355, '127.0.0.1', () => { if (!waitReply) { clearTimeout(timer); s.close(); resolve(''); } });
  });
}
function writeLaunch(core, rom) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(STATE + '/launch.env', `CORE=${core}\nROM=${rom}\n`);
}

(async () => {
  // Video mode is running (the entrypoint started it).
  check(active('video-mode'), 'video-mode unit is active at start', ctl('is-active', 'video-mode').stdout);
  check(!active('game-mode'), 'game-mode unit is inactive at start', '');

  // Starting game mode must stop video mode (Conflicts=).
  writeLaunch('', '');
  ctl('start', 'game-mode');
  await sleep(1200);
  check(active('game-mode') && !active('video-mode'), 'starting game-mode stops video-mode', `game=${active('game-mode')} video=${active('video-mode')}`);

  // Menu only: no content, so RetroArch reports CONTENTLESS.
  check((await udp('GET_STATUS')) === 'GET_STATUS CONTENTLESS', 'menu only start reports CONTENTLESS', 'no reply or wrong reply');

  // Launch a game through the real run-retroarch.sh and launch.env.
  const core = HOME + '/cores/nestopia_libretro.so';
  const rom = HOME + '/roms/nes/Demo Game A.nes';
  writeLaunch(core, rom);
  ctl('restart', 'game-mode');
  await sleep(1200);
  const st = await udp('GET_STATUS');
  check(st && st.startsWith('GET_STATUS PLAYING') && st.includes('Demo Game A.nes'), 'launch.env launches the right game (path with spaces)', String(st));

  // In game controls over the network command port.
  await udp('PAUSE_TOGGLE', false); await sleep(200);
  check((await udp('GET_STATUS')).startsWith('GET_STATUS PAUSED'), 'PAUSE_TOGGLE pauses', '');
  await udp('PAUSE_TOGGLE', false); await sleep(200);
  check((await udp('GET_STATUS')).startsWith('GET_STATUS PLAYING'), 'PAUSE_TOGGLE resumes', '');
  await udp('SAVE_STATE', false); await sleep(300);
  check(fs.existsSync(HOME + '/states/Demo Game A.nes.state'), 'SAVE_STATE writes a state file', 'missing');
  await udp('CLOSE_CONTENT', false); await sleep(200);
  check((await udp('GET_STATUS')) === 'GET_STATUS CONTENTLESS', 'CLOSE_CONTENT returns to the menu', '');

  // Autosave on stop while playing.
  writeLaunch(core, rom);
  ctl('restart', 'game-mode'); await sleep(1200);
  ctl('stop', 'game-mode'); await sleep(600);
  check(fs.existsSync(HOME + '/states/Demo Game A.nes.state.auto'), 'stopping a running game autosaves', 'missing');

  // A launch.env cannot run code: it is parsed, never sourced.
  fs.writeFileSync(STATE + '/launch.env', `CORE=\nROM=$(touch /tmp/PWNED)\n`);
  ctl('start', 'game-mode'); await sleep(800); ctl('stop', 'game-mode');
  check(!fs.existsSync('/tmp/PWNED'), 'launch.env values are never executed', 'command ran');

  // Failure injection works (needed by later fault tests).
  writeLaunch('', '');
  execFileSync('bash', ['-c', 'SIM_FAIL=start systemctl --user start game-mode; sleep 1']);
  check(!active('game-mode'), 'SIM_FAIL=start makes the unit exit', 'still active');

  // Back to video mode.
  ctl('start', 'video-mode'); await sleep(1500);
  check(active('video-mode') && !active('game-mode'), 'starting video-mode brings VLC back', '');

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });

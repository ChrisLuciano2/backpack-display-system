// Protocol v2 end to end: drives the REAL server/index.js (not mode.js directly)
// through the fake phone, against real VLC and the fake RetroArch. Checks the
// new commands, the gating of Video Mode commands, and that a v1 client (no
// hello) still gets exactly the old behavior.
'use strict';

const { Phone } = require('../phone');

let failures = 0;
function check(ok, name, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures += 1;
}
const last = (arr, pred) => arr.filter(pred).pop();

// The fake Bluetooth stub accepts one phone at a time and briefly refuses a
// new connection while the server is recreating its listener after the last
// one left. Retry instead of tying every caller to a fixed sleep.
async function connectWithRetry(tries = 10) {
  for (let i = 0; i < tries; i++) {
    try { return await new Phone().connect(); } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  throw new Error('could not connect the fake phone');
}

(async () => {
  // ── Part 1: a v1 client (the installed app) — no hello, ever ──────────────
  const v1 = await connectWithRetry();
  await v1.sleep(1500);

  const onConnect = v1.messages[0];
  check(onConnect && typeof onConnect.status === 'string' && onConnect.file === undefined || 'file' in onConnect,
    'v1: the on-connect message has the classic status shape', JSON.stringify(onConnect));
  check(!('hello' in onConnect), 'v1: no hello field appears unasked', JSON.stringify(onConnect));

  v1.send({ action: 'play', file: 'short one.mp4' });
  const playedV1 = await v1.waitForStatus((s) => s.status === 'playing' && s.file === 'short one.mp4', 6000);
  check(playedV1, 'v1: play still works with the classic reply shape', JSON.stringify(v1.status));
  check(v1.status.mode === 'video' || v1.status.mode === undefined, 'v1: mode field (if present) says video, and does not break anything', JSON.stringify(v1.status));

  v1.send({ action: 'stop' });
  await v1.sleep(400);
  v1.close();

  // The server tears down and recreates its listener ~1 s after a disconnect
  // (server/index.js: setTimeout(startListening, 1000)) — the same gap the
  // real Bluetooth server has between one phone leaving and the next arriving.
  await v1.sleep(1800);

  // ── Part 2: a v2 client ────────────────────────────────────────────────────
  const phone = await connectWithRetry();
  await phone.sleep(500);

  phone.send({ action: 'hello', v: 2, id: 'h1' });
  await phone.sleep(400);
  const hello = last(phone.messages, (m) => m.hello);
  check(hello && hello.v === 2 && hello.id === 'h1', 'hello replies with v2 and echoes the id', JSON.stringify(hello));
  check(hello && hello.mode === 'video', 'hello reports the starting mode', JSON.stringify(hello));
  check(Array.isArray(hello && hello.caps) && hello.caps.includes('mode'), 'hello lists mode in its caps', JSON.stringify(hello));

  phone.send({ action: 'systems', id: 's1' });
  await phone.sleep(400);
  const systemsMsg = last(phone.messages, (m) => m.systems);
  check(systemsMsg && systemsMsg.id === 's1', 'systems reply carries the request id', JSON.stringify(systemsMsg));
  const nes = systemsMsg && systemsMsg.systems.find((s) => s.id === 'nes');
  check(nes && nes.ready === 'ready' && nes.games >= 1, 'nes reports ready with fixture games', JSON.stringify(nes));
  const snes = systemsMsg && systemsMsg.systems.find((s) => s.id === 'snes');
  check(snes && snes.ready === 'ready', 'snes reports ready', JSON.stringify(snes));
  const gba = systemsMsg && systemsMsg.systems.find((s) => s.id === 'gba');
  check(gba && gba.ready === 'no_core', 'gba (no core in the fixture) reports no_core', JSON.stringify(gba));
  const ps1 = systemsMsg && systemsMsg.systems.find((s) => s.id === 'ps1');
  check(ps1 && ps1.ready === 'needs_bios', 'ps1 (no BIOS in the fixture) reports needs_bios', JSON.stringify(ps1));

  phone.send({ action: 'library', system: 'nes', id: 'l1' });
  await phone.sleep(400);
  const libMsg = last(phone.messages, (m) => m.library);
  check(libMsg && libMsg.id === 'l1' && libMsg.library.items.length >= 1, 'library lists nes games', JSON.stringify(libMsg));
  const gameId = libMsg.library.items[0].id;
  check(/^nes:[0-9a-f]{12}$/.test(gameId), 'a game id has the expected shape', gameId);

  phone.send({ action: 'library', system: 'not-a-system', id: 'l2' });
  await phone.sleep(300);
  const badLib = last(phone.messages, (m) => m.id === 'l2');
  check(badLib && badLib.error && badLib.code === 'invalid_id', 'an unknown system is a clean error, not a crash', JSON.stringify(badLib));

  // ── Video is still playing: enqueue and check it is really there ──────────
  phone.send({ action: 'play', file: 'long clip.mp4' });
  await phone.waitForStatus((s) => s.status === 'playing' && s.file === 'long clip.mp4', 6000);

  // ── Switch to Game Mode ─────────────────────────────────────────────────
  phone.send({ action: 'mode', target: 'game', id: 'm1' });
  const inGame = await phone.waitForStatus((s) => s.mode === 'game', 12000);
  check(inGame, 'mode:game reaches Game Mode', JSON.stringify(phone.status));
  const modeReply = last(phone.messages, (m) => m.id === 'm1');
  check(modeReply && modeReply.mode === 'game', 'the mode command itself replies with the new mode', JSON.stringify(modeReply));

  // A Video Mode command must now be refused, not silently ignored.
  phone.errors.length = 0;
  phone.send({ action: 'volume', level: 50, id: 'v1' });
  await phone.sleep(400);
  const refused = last(phone.messages, (m) => m.id === 'v1');
  check(refused && refused.code === 'not_in_mode', 'a Video Mode command is refused while in Game Mode', JSON.stringify(refused));

  // "list" (media browser) still works in Game Mode.
  phone.send({ action: 'list' });
  await phone.sleep(500);
  const listMsg = last(phone.messages, (m) => m.files);
  check(listMsg && Array.isArray(listMsg.files), '"list" still works in Game Mode', JSON.stringify(listMsg && listMsg.files));

  // ── Launch a game and control it ──────────────────────────────────────────
  phone.send({ action: 'launchgame', gameId, id: 'lg1' });
  const playing = await phone.waitForStatus((s) => s.mode === 'game' && s.game && s.game.id === gameId, 15000);
  check(playing, 'launchgame reaches playing with the right game id', JSON.stringify(phone.status));

  phone.send({ action: 'gamectl', op: 'pause', id: 'g1' });
  await phone.sleep(1500);
  const paused = last(phone.messages, (m) => m.id === 'g1');
  check(paused && paused.ok, 'gamectl pause acknowledges', JSON.stringify(paused));

  phone.send({ action: 'gamectl', op: 'savestate', id: 'g2' });
  await phone.sleep(2500);
  const savedMsg = last(phone.messages, (m) => m.id === 'g2');
  check(savedMsg && savedMsg.saved === true, 'gamectl savestate confirms a real state file', JSON.stringify(savedMsg));

  phone.send({ action: 'gamectl', op: 'swap', id: 'g3' });
  await phone.sleep(300);
  const swapMsg = last(phone.messages, (m) => m.id === 'g3');
  check(swapMsg && swapMsg.code === 'not_implemented', 'gamectl swap says not_implemented rather than pretending to work', JSON.stringify(swapMsg));

  phone.send({ action: 'launchgame', gameId: '../../etc/passwd', id: 'lg2' });
  await phone.sleep(300);
  const badGame = last(phone.messages, (m) => m.id === 'lg2');
  check(badGame && badGame.error, 'a hostile gameId is refused, not launched', JSON.stringify(badGame));

  phone.send({ action: 'gamectl', op: 'quit', id: 'g4' });
  const backToMenu = await phone.waitForStatus((s) => s.mode === 'game' && s.game === null, 8000);
  check(backToMenu, 'gamectl quit returns to the game menu', JSON.stringify(phone.status));

  // ── Back to Video Mode: the video resumes ─────────────────────────────────
  phone.send({ action: 'mode', target: 'video', id: 'm2' });
  const backToVideo = await phone.waitForStatus((s) => s.mode === 'video', 12000);
  check(backToVideo, 'mode:video returns to Video Mode', JSON.stringify(phone.status));
  await phone.sleep(1500);
  const resumed = await phone.waitForStatus((s) => s.status === 'playing' && s.file === 'long clip.mp4', 4000);
  check(resumed, 'the same video is playing again after the round trip', JSON.stringify(phone.status));

  // A previously v1-only client reconnecting still works the old way.
  phone.close();
  await phone.sleep(1800);
  const v1again = await connectWithRetry();
  await v1again.sleep(1200);
  v1again.send({ action: 'list' });
  await v1again.sleep(500);
  const filesAgain = last(v1again.messages, (m) => m.files);
  check(filesAgain && Array.isArray(filesAgain.files), 'a v1 client can still reconnect and list files after all this', JSON.stringify(filesAgain));
  v1again.close();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('scenario crashed:', e); process.exit(2); });

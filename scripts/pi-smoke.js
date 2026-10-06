#!/usr/bin/env node
// pi-smoke.js: runs the real mode switching round trip against the real server on the Pi
// and times every step. Needs the server running with DEBUG_TCP=1 (see server/transport-tcp.js).
//
//   node scripts/pi-smoke.js [cycles] [game name to launch]
//
// Each cycle: Video Mode -> Game Mode -> launch a game -> in game controls -> back to
// Video Mode, and checks the video comes back. Prints a table and exits non zero on failure.
'use strict';

const { Phone } = require('./phone');

const cycles = Number(process.argv[2] || 3);
const wantedGame = (process.argv[3] || 'Super Mario Kart').toLowerCase();
const rows = [];
let failures = 0;

const ms = (t0) => Math.round(Date.now() - t0);
function note(ok, what, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + what + (detail ? '   ' + detail : ''));
  if (!ok) failures += 1;
}
const last = (arr, pred) => arr.filter(pred).pop();

(async () => {
  const p = await new Phone().connect();
  await p.sleep(1000);
  let n = 0;
  const send = (o) => { n += 1; const id = 'c' + n; p.send(Object.assign({ id }, o)); return id; };
  const reply = async (id, ms_ = 6000) => {
    const t = Date.now();
    while (Date.now() - t < ms_) { const r = last(p.messages, (m) => m.id === id); if (r) return r; await p.sleep(50); }
    return null;
  };

  send({ action: 'hello', v: 2 });
  await p.sleep(500);
  const hello = last(p.messages, (m) => m.hello);
  note(!!hello && hello.v === 2, 'hello', JSON.stringify(hello && { mode: hello.mode, caps: hello.caps }));
  if (!hello) process.exit(1);

  // Something to resume: the first video in the media folder.
  send({ action: 'list' });
  await p.sleep(800);
  const files = (last(p.messages, (m) => m.movies) || {}).movies || [];
  // A long clip, so it is still playing when each cycle ends. A short one finishes on its own
  // and leaves nothing to resume.
  const video = files.find((f) => /1080p/i.test(f) && /\.mp4$/i.test(f)) || files.find((f) => /\.mp4$/i.test(f));
  if (!video) { note(false, 'a video file to play', 'none found in the media folder'); process.exit(1); }
  send({ action: 'play', file: video });
  const playing = await p.waitForStatus((s) => s.status === 'playing' && s.file === video, 15000);
  note(playing, `video starts: ${video}`);

  // Find the game id.
  const libId = send({ action: 'library', system: 'snes' });
  const lib = await reply(libId);
  const item = lib && lib.library && lib.library.items.find((g) => g.name.toLowerCase().includes(wantedGame));
  note(!!item, `game in the library: ${wantedGame}`, item ? item.id : JSON.stringify(lib && lib.library && lib.library.ready));
  if (!item) process.exit(1);

  for (let c = 1; c <= cycles; c++) {
    console.log(`\n--- cycle ${c} of ${cycles}`);
    const row = { cycle: c };

    await p.sleep(1500);
    const before = p.status && p.status.pos;
    let t0 = Date.now();
    send({ action: 'mode', target: 'game' });
    let ok = await p.waitForStatus((s) => s.mode === 'game' && s.phase === 'menu', 25000);
    row.toGame = ok ? ms(t0) : null;
    note(ok, 'switch to Game Mode', ok ? row.toGame + ' ms' : 'timed out');
    if (!ok) { rows.push(row); break; }

    t0 = Date.now();
    send({ action: 'launchgame', gameId: item.id });
    ok = await p.waitForStatus((s) => s.mode === 'game' && s.phase === 'playing' && s.game && s.game.id === item.id, 30000);
    row.launch = ok ? ms(t0) : null;
    note(ok, 'launch the game', ok ? row.launch + ' ms' : 'timed out ' + JSON.stringify(p.status && { mode: p.status.mode, game: p.status.game }));
    if (!ok) { rows.push(row); break; }

    await p.sleep(3000);          // let it run for a moment
    if (c === 1) {
      const a = await reply(send({ action: 'gamectl', op: 'pause' }));
      note(!!a && a.ok, 'pause', JSON.stringify(a));
      await p.sleep(800);
      const b = await reply(send({ action: 'gamectl', op: 'resume' }));
      note(!!b && b.ok, 'resume', JSON.stringify(b));
      await p.sleep(800);
      // Informational only: the Debian emulators on this Pi report "Core does not support save states".
      const s = await reply(send({ action: 'gamectl', op: 'savestate' }), 8000);
      console.log('INFO save state: ' + JSON.stringify(s) + ' (known limitation on this Pi)');
    }

    t0 = Date.now();
    send({ action: 'mode', target: 'video', force: true });
    ok = await p.waitForStatus((s) => s.mode === 'video', 25000);
    row.toVideo = ok ? ms(t0) : null;
    note(ok, 'switch back to Video Mode', ok ? row.toVideo + ' ms' : 'timed out');
    if (!ok) { rows.push(row); break; }

    ok = await p.waitForStatus((s) => s.mode === 'video' && s.status === 'playing' && s.file === video, 15000);
    row.resumed = ok;
    note(ok, 'the video is playing again', ok ? `position ${p.status.pos}s (was ${before}s before)` : JSON.stringify(p.status && { status: p.status.status, file: p.status.file }));
    rows.push(row);
  }

  console.log('\nTIMELINE (clock time, every change of mode or phase)');
  const t00 = p.messages[0]._t;
  let prev = '';
  for (const m of p.messages) {
    if (!m.status || m.mode === undefined) continue;
    const key = `${m.mode}/${m.phase}/${m.status}/${m.file || ''}/${m.game ? m.game.name : ''}`;
    if (key !== prev) { console.log(`  ${new Date(m._t).toTimeString().slice(0, 8)}.${String(m._t % 1000).padStart(3, '0')}  mode=${m.mode} phase=${m.phase} video=${m.status} file=${m.file || '-'} game=${m.game ? m.game.name : '-'}`); prev = key; }
  }

  console.log('\nSUMMARY');
  console.table(rows);
  const good = rows.filter((r) => r.toGame && r.launch && r.toVideo && r.resumed).length;
  console.log(`${good} of ${cycles} cycles completed cleanly. ${failures} failed check(s).`);
  p.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });

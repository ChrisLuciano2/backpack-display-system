// Race scenarios against the REAL VLC web interface and the real server/index.js.
// Prints PASS or FAIL per check and exits non-zero if anything failed.
'use strict';

const { Phone } = require('../phone');

let failures = 0;
function check(ok, name, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures += 1;
}

const ONE = 'short one.mp4';
const TWO = 'short two.mp4';
const THREE = 'short three.mp4';
const LONG = 'long clip.mp4';
const ALICE = "Alice's Wonderland.mp4";

async function fileNow(phone) {
  phone.send({ action: 'list' });
  await phone.sleep(500);
  return phone.status ? phone.status.file : null;
}

async function reset(phone) {
  phone.send({ action: 'stop' });
  await phone.sleep(300);
  phone.send({ action: 'clearqueue' });
  await phone.sleep(500);
  phone.errors.length = 0;
}

(async () => {
  const phone = await new Phone().connect();
  await phone.sleep(1500); // let the on-connect messages arrive

  // 1. Basics: the file list arrives and a name with an apostrophe and spaces plays.
  phone.send({ action: 'list' });
  await phone.sleep(600);
  const files = (phone.messages.filter((m) => m.files).pop() || {}).files || [];
  check(files.includes(ALICE) && files.includes(ONE), 'file list includes names with spaces and an apostrophe', JSON.stringify(files));

  phone.send({ action: 'play', file: ALICE });
  const played = await phone.waitForStatus((s) => s.status === 'playing' && s.file === ALICE, 6000);
  check(played, 'a filename with a space and an apostrophe plays', JSON.stringify(phone.status));
  await reset(phone);

  // 2. Double tap: two plays in the same instant. The second must win, cleanly.
  phone.send({ action: 'play', file: ONE });
  phone.send({ action: 'play', file: TWO });
  const two = await phone.waitForStatus((s) => s.status === 'playing' && s.file === TWO, 8000);
  await phone.sleep(1500);
  const after = await fileNow(phone);
  check(two && after === TWO, 'double tap: the second play wins and stays', 'file now = ' + after);
  check(phone.errors.length === 0, 'double tap: no errors sent to the phone', JSON.stringify(phone.errors));
  await reset(phone);

  // 3. Ten rapid plays. The last one requested must be what ends up playing.
  const names = [ONE, TWO, THREE, ONE, TWO, THREE, ONE, TWO, THREE, LONG];
  for (const n of names) phone.send({ action: 'play', file: n });
  await phone.waitForStatus((s) => s.status === 'playing' && s.file === LONG, 15000);
  await phone.sleep(1500);
  const rapid = await fileNow(phone);
  check(rapid === LONG, 'ten rapid plays: the last request is what plays', 'file now = ' + rapid);
  await reset(phone);

  // 4. Natural end advances the queue on its own.
  phone.send({ action: 'play', file: ONE });
  await phone.waitForStatus((s) => s.status === 'playing' && s.file === ONE, 6000);
  phone.send({ action: 'enqueue', file: TWO });
  const advanced = await phone.waitForStatus((s) => s.file === TWO && s.status === 'playing', 12000);
  check(advanced, 'natural end of a clip advances to the queued clip', JSON.stringify(phone.status));
  await reset(phone);

  // 5. The real race: the user picks a file at the exact moment the current clip
  //    ends and the queue would auto-advance. The user's pick must win every time.
  const offsetsMs = [3300, 3600, 3800, 3950, 4100, 4300];
  for (const offset of offsetsMs) {
    phone.send({ action: 'play', file: ONE });
    await phone.waitForStatus((s) => s.status === 'playing' && s.file === ONE, 6000);
    phone.send({ action: 'clearqueue' });
    phone.send({ action: 'enqueue', file: THREE });
    await phone.sleep(offset);
    phone.send({ action: 'play', file: LONG });
    await phone.sleep(3500); // long enough for the watcher to misbehave if it is going to
    const f = await fileNow(phone);
    check(f === LONG, 'user pick at ' + offset + ' ms after start beats the auto-advance', 'file now = ' + f);
    await reset(phone);
  }

  phone.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('scenario crashed:', e.message); process.exit(2); });

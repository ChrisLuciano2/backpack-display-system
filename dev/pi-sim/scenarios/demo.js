// Staged demo for screenshots. The host touches /tmp/go1, /tmp/go2, ... and each
// stage runs once its flag file appears, so screenshots line up with known states.
'use strict';
const fs = require('fs');
const { Phone } = require('../phone');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function flag(n) { while (!fs.existsSync('/tmp/go' + n)) await sleep(100); }
(async () => {
  const p = await new Phone().connect();
  await sleep(800);
  p.send({ action: 'hello', v: 2, id: 'h' });
  await flag(1);
  p.send({ action: 'play', file: 'long clip.mp4' });
  await sleep(2500); p.send({ action: 'seek', seconds: 20 });
  fs.writeFileSync('/tmp/done1', '1');
  await flag(2);
  p.send({ action: 'mode', target: 'game', id: 'm1' });
  await sleep(3500); fs.writeFileSync('/tmp/done2', '1');
  await flag(3);
  p.send({ action: 'library', system: 'nes', id: 'l' });
  await sleep(600);
  const lib = p.messages.filter((m) => m.library).pop();
  p.send({ action: 'launchgame', gameId: lib.library.items[0].id, id: 'g' });
  await sleep(4000); fs.writeFileSync('/tmp/done3', '1');
  await flag(4);
  p.send({ action: 'gamectl', op: 'pause', id: 'p' });
  await sleep(1500); fs.writeFileSync('/tmp/done4', '1');
  await flag(5);
  p.send({ action: 'mode', target: 'video', force: true, id: 'm2' });
  await sleep(5000); fs.writeFileSync('/tmp/done5', '1');
  await flag(6);
  p.close();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandQueue } = require('../commandQueue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs commands in arrival order', async () => {
  const q = new CommandQueue();
  const order = [];
  await Promise.all([
    q.run(async () => { await sleep(30); order.push('a'); }),
    q.run(async () => { await sleep(5);  order.push('b'); }),
    q.run(async () => { order.push('c'); }),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('never runs two commands at once', async () => {
  const q = new CommandQueue();
  let running = 0;
  let maxRunning = 0;
  const job = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await sleep(10);
    running -= 1;
  };
  await Promise.all(Array.from({ length: 6 }, () => q.run(job)));
  assert.equal(maxRunning, 1);
});

test('resolves with the command result', async () => {
  const q = new CommandQueue();
  assert.equal(await q.run(async () => 42), 42);
});

test('a failing command does not stall later commands', async () => {
  const q = new CommandQueue();
  const bad = q.run(async () => { throw new Error('boom'); });
  const good = q.run(async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('a command past its deadline fails with code timeout and the queue moves on', async () => {
  const q = new CommandQueue();
  const slow = q.run(() => sleep(200), { label: 'slow', timeoutMs: 30 });
  const next = q.run(async () => 'after');
  await assert.rejects(slow, (err) => err.code === 'timeout' && /slow timed out/.test(err.message));
  assert.equal(await next, 'after');
});

test('isBusy and size track queued and running commands', async () => {
  const q = new CommandQueue();
  assert.equal(q.isBusy(), false);
  const a = q.run(() => sleep(20));
  const b = q.run(() => sleep(20));
  assert.equal(q.isBusy(), true);
  assert.equal(q.size(), 2);
  await Promise.all([a, b]);
  assert.equal(q.isBusy(), false);
  assert.equal(q.size(), 0);
});

test('synchronous throw inside a command is a rejection, not a crash', async () => {
  const q = new CommandQueue();
  await assert.rejects(q.run(() => { throw new Error('sync'); }), /sync/);
  assert.equal(await q.run(async () => 'still works'), 'still works');
});

// Reproduces the real bug: two rapid "play" commands used to run together.
test('double tap: two plays never overlap their stop and start steps', async () => {
  const q = new CommandQueue();
  const log = [];
  const play = (name) => async () => {
    log.push(`${name}:stop`);
    await sleep(15);            // waitForStopped
    log.push(`${name}:start`);
  };
  await Promise.all([q.run(play('one')), q.run(play('two'))]);
  assert.deepEqual(log, ['one:stop', 'one:start', 'two:stop', 'two:start']);
});

// Reproduces the second bug: a watcher decision made before a user command,
// applied after it, advanced the queue over the user's pick. Re-checking inside
// the lock fixes it.
test('watcher re-check inside the lock sees the user pick, not stale state', async () => {
  const q = new CommandQueue();
  const state = { nowPlaying: 'old.mp4', vlc: 'playing', advanced: false };

  // User taps play on a new file: vlc briefly reports stopped mid switch.
  const userPlay = q.run(async () => {
    state.vlc = 'stopped';
    await sleep(20);
    state.nowPlaying = 'picked.mp4';
    state.vlc = 'playing';
  });

  // Watcher tick fires during the switch. It queues its check behind the play.
  const watcher = q.run(async () => {
    if (state.vlc === 'stopped') state.advanced = true; // only advance if still stopped
  });

  await Promise.all([userPlay, watcher]);
  assert.equal(state.advanced, false);
  assert.equal(state.nowPlaying, 'picked.mp4');
});

// server/commandQueue.js
// Runs control commands one at a time, in arrival order, each with a deadline.
//
// Why: the Bluetooth data handler used to call dispatch() without waiting, so
// two commands within a few hundred ms ran at once (double tap on Next started
// two plays), and the queue watcher could auto-advance while a play command
// was mid stop. Serializing everything through one lane removes both races.
//
// A command that misses its deadline is failed with a timeout error and the
// queue moves on. The underlying work is not cancelled (a promise cannot be),
// so its late result is ignored.

'use strict';

class CommandQueue {
  constructor() {
    this._tail = Promise.resolve(); // resolves when everything queued so far is done
    this._pending = 0;              // queued or running, not yet finished
  }

  // True while any command is queued or running. The queue watcher uses this
  // to skip its tick instead of racing a user command.
  isBusy() {
    return this._pending > 0;
  }

  // Number of commands queued or running.
  size() {
    return this._pending;
  }

  // Queue fn to run after everything already queued. Resolves with fn's result,
  // or rejects with fn's error or a timeout error. Never blocks later commands.
  run(fn, { label = 'command', timeoutMs = 5000 } = {}) {
    this._pending += 1;

    const job = this._tail.then(() => this._withDeadline(fn, label, timeoutMs));

    // The tail must always resolve, even if this job fails, or one failure
    // would stall every later command.
    this._tail = job.then(
      () => { this._pending -= 1; },
      () => { this._pending -= 1; },
    );

    return job;
  }

  _withDeadline(fn, label, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error(`${label} timed out after ${timeoutMs} ms`);
        err.code = 'timeout';
        reject(err);
      }, timeoutMs);

      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          },
        );
    });
  }
}

module.exports = { CommandQueue };

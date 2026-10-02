// server/launchFile.js
// Tells the game-mode service what to run next. The server writes CORE= and ROM=
// to a small file just before starting or restarting the unit, and
// scripts/run-retroarch.sh reads it. Both empty means "menu only".
//
// The launch script parses this file line by line and never runs it as code, and
// this writer refuses any value that could break that format.

'use strict';

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./config');

function clean(value, label) {
  const v = String(value || '');
  if (/[\r\n\0]/.test(v)) throw new Error(`${label} contains a line break or null byte`);
  return v;
}

function createLaunchFile(dir = STATE_DIR) {
  const file = path.join(dir, 'launch.env');
  return {
    file,
    async write(core, rom) {
      const c = clean(core, 'core');
      const r = clean(rom, 'rom');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, `CORE=${c}\nROM=${r}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file); // atomic: the launch script never sees a half written file
    },
  };
}

module.exports = { createLaunchFile };

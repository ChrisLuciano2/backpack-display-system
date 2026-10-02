// server/units.js
// Starts and stops the two mode services through systemd (`systemctl --user`).
// The mode manager only ever talks to this interface, so tests and the virtual
// Pi can swap in a fake. Arguments are passed as an array, never through a shell.

'use strict';

const { execFile } = require('child_process');

function systemctl(args) {
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

const unitName = (u) => `${u}.service`;

module.exports = {
  async start(unit) {
    const r = await systemctl(['start', unitName(unit)]);
    if (r.code !== 0) throw new Error(`systemctl start ${unit} failed: ${r.stderr.trim() || 'exit ' + r.code}`);
  },
  async stop(unit) {
    await systemctl(['stop', unitName(unit)]);
  },
  async restart(unit) {
    const r = await systemctl(['restart', unitName(unit)]);
    if (r.code !== 0) throw new Error(`systemctl restart ${unit} failed: ${r.stderr.trim() || 'exit ' + r.code}`);
  },
  async isActive(unit) {
    const r = await systemctl(['is-active', unitName(unit)]);
    return r.stdout.trim() === 'active';
  },
};

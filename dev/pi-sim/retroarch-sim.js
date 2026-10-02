// Fake RetroArch for the virtual Pi.
//
// It imitates RetroArch from the outside only: the same command line
// (--fullscreen, --config FILE, -L CORE, CONTENT), the same UDP network command
// port (55355 on localhost) and the same process behavior (runs until told to
// quit, exits on SIGTERM). The real emulation is not simulated. Everything
// real RetroArch might do differently is checked in Phase 0 on the real Pi.
//
// Failure injection (environment variables):
//   SIM_FAIL=start        exit immediately with an error
//   SIM_START_DELAY_MS=N  wait N ms before answering commands (default 300)
//   SIM_CRASH_AFTER_MS=N  exit with an error N ms after start
'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const LOG = '/tmp/retroarch-sim.log';
const STATES_DIR = process.env.SIM_STATES_DIR || (process.env.HOME || '/tmp') + '/states';
const PORT = Number(process.env.SIM_UDP_PORT || 55355);

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}

// ── Parse the command line like RetroArch ────────────────────────────────────
const argv = process.argv.slice(2);
let core = null;
let content = null;
let config = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-L') core = argv[++i];
  else if (argv[i] === '--config') config = argv[++i];
  else if (argv[i].startsWith('--')) { /* flag such as --fullscreen */ }
  else content = argv[i];
}
log(`start core=${core || '-'} content=${content || '-'} config=${config || '-'}`);

if (process.env.SIM_FAIL === 'start') {
  log('SIM_FAIL=start: exiting with an error');
  process.exit(1);
}
if (content && !fs.existsSync(content)) {
  log('content not found: ' + content);
  process.exit(1);
}
if (core && !fs.existsSync(core)) {
  log('core not found: ' + core);
  process.exit(1);
}

// ── State ────────────────────────────────────────────────────────────────────
let hasContent = !!content;
let paused = false;
let ready = false;
const contentName = content ? path.basename(content) : '';
const system = core ? path.basename(core).replace(/_libretro\.so$/, '') : 'core';

function stateFile(slot) {
  return path.join(STATES_DIR, contentName + '.state' + (slot || ''));
}
function writeState(file) {
  fs.mkdirSync(STATES_DIR, { recursive: true });
  fs.writeFileSync(file, 'sim state ' + Date.now());
}

// ── UDP command port ─────────────────────────────────────────────────────────
const sock = dgram.createSocket('udp4');
sock.on('message', (buf, rinfo) => {
  if (!ready) return; // not answering yet, like a starting RetroArch
  const text = buf.toString('utf8').trim();
  const [cmd, ...rest] = text.split(' ');
  log('udp <- ' + text);
  let reply = null;
  switch (cmd) {
    case 'GET_STATUS':
      reply = hasContent
        ? `GET_STATUS ${paused ? 'PAUSED' : 'PLAYING'} ${system},${contentName},crc32=00000000`
        : 'GET_STATUS CONTENTLESS';
      break;
    case 'PAUSE_TOGGLE': if (hasContent) paused = !paused; break;
    case 'SAVE_STATE':   if (hasContent) writeState(stateFile('')); break;
    case 'LOAD_STATE':   break;
    case 'RESET':        if (hasContent) paused = false; break;
    case 'CLOSE_CONTENT': hasContent = false; paused = false; break;
    case 'SHOW_MSG':     log('on screen message: ' + rest.join(' ')); break;
    case 'QUIT':         shutdown(0); return;
    default:             break;
  }
  if (reply) sock.send(reply, rinfo.port, rinfo.address);
});
sock.on('error', (err) => { log('udp error: ' + err.message); process.exit(1); });
sock.bind(PORT, '127.0.0.1');

const delay = Number(process.env.SIM_START_DELAY_MS || 300);
setTimeout(() => { ready = true; log('ready'); }, delay);

if (process.env.SIM_CRASH_AFTER_MS) {
  setTimeout(() => { log('SIM_CRASH_AFTER_MS reached: crashing'); process.exit(1); }, Number(process.env.SIM_CRASH_AFTER_MS));
}

// ── Exit behavior ────────────────────────────────────────────────────────────
function shutdown(code) {
  // Autosave on exit, like savestate_auto_save.
  if (hasContent) { try { writeState(stateFile('.auto')); log('autosaved on exit'); } catch { /* ignore */ } }
  log('exit ' + code);
  try { sock.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

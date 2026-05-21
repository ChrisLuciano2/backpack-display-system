/**
 * patch-bt.js
 *
 * Patches bluetooth-serial-port's BTSerialPortBinding.cc to compile with
 * Node.js 20. The package uses two V8 APIs that were removed in Node 12+:
 *
 *   Object::Get(Local<String>)   → needs context argument
 *   Object::Set(Local<String>,…) → needs context argument
 *
 * Run AFTER npm install --ignore-scripts, then this script applies the
 * two-line fix and triggers a fresh node-gyp build.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = path.join(
  __dirname, '..', 'node_modules', 'bluetooth-serial-port',
  'src', 'linux', 'BTSerialPortBinding.cc'
);

if (!fs.existsSync(SRC)) {
  console.error('ERROR: bluetooth-serial-port source not found at', SRC);
  console.error('Run:  npm install --ignore-scripts   first.');
  process.exit(1);
}

let src = fs.readFileSync(SRC, 'utf8');

// ── Patch 1: Object::Get needs a context argument ───────────────────────────
const OLD_GET =
  'Local<Function>::Cast(globalObj->Get(Nan::New("Buffer").ToLocalChecked()))';
const NEW_GET =
  'Local<Function>::Cast(globalObj->Get(Nan::GetCurrentContext(), Nan::New("Buffer").ToLocalChecked()).ToLocalChecked())';

if (!src.includes(OLD_GET)) {
  if (src.includes(NEW_GET)) {
    console.log('Patch 1 already applied — skipping.');
  } else {
    console.error('ERROR: Patch 1 target string not found. Has the source changed?');
    process.exit(1);
  }
} else {
  src = src.replace(OLD_GET, NEW_GET);
  console.log('Patch 1 applied: Object::Get → context-aware form');
}

// ── Patch 2: Object::Set needs a context argument ───────────────────────────
const OLD_SET =
  'target->Set(Nan::New("BTSerialPortBinding").ToLocalChecked(), t->GetFunction(ctx).ToLocalChecked())';
const NEW_SET =
  'target->Set(ctx, Nan::New("BTSerialPortBinding").ToLocalChecked(), t->GetFunction(ctx).ToLocalChecked())';

if (!src.includes(OLD_SET)) {
  if (src.includes(NEW_SET)) {
    console.log('Patch 2 already applied — skipping.');
  } else {
    console.error('ERROR: Patch 2 target string not found. Has the source changed?');
    process.exit(1);
  }
} else {
  src = src.replace(OLD_SET, NEW_SET);
  console.log('Patch 2 applied: Object::Set → context-aware form');
}

fs.writeFileSync(SRC, src);
console.log('Source patched. Rebuilding…');

const MODULE_DIR = path.join(__dirname, '..', 'node_modules', 'bluetooth-serial-port');
execSync('node-gyp build', { cwd: MODULE_DIR, stdio: 'inherit' });

console.log('');
console.log('bluetooth-serial-port rebuilt successfully for Node.js 20 ✓');

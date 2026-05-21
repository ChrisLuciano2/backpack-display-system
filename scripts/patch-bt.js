/**
 * patch-bt.js
 *
 * Patches bluetooth-serial-port to compile with Node.js 20.
 * The package uses V8 APIs removed in Node 12+:
 *   Object::Get(Local<String>)      → needs context argument
 *   Object::Set(Local<String>, …)   → needs context argument
 *   Array::Get(Local<Integer>)      → needs context argument
 *
 * Two files need patching:
 *   BTSerialPortBinding.cc       (client side)
 *   BTSerialPortBindingServer.cc (server side — what we use)
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = path.join(__dirname, '..', 'node_modules', 'bluetooth-serial-port', 'src', 'linux');

function patchFile(filename, patches) {
  const file = path.join(BASE, filename);
  if (!fs.existsSync(file)) {
    console.error('ERROR: not found:', file);
    process.exit(1);
  }
  let src = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [label, oldStr, newStr] of patches) {
    if (src.includes(oldStr)) {
      src = src.replace(oldStr, newStr);
      console.log(`  ✓ ${label}`);
      changed = true;
    } else if (src.includes(newStr)) {
      console.log(`  – ${label} already applied`);
    } else {
      console.error(`  ✗ ${label}: target not found — source may have changed`);
      process.exit(1);
    }
  }
  if (changed) fs.writeFileSync(file, src);
}

// ── BTSerialPortBinding.cc (client) ─────────────────────────────────────────
console.log('Patching BTSerialPortBinding.cc…');
patchFile('BTSerialPortBinding.cc', [
  [
    'Object::Get → context-aware (Buffer constructor)',
    'Local<Function>::Cast(globalObj->Get(Nan::New("Buffer").ToLocalChecked()))',
    'Local<Function>::Cast(globalObj->Get(Nan::GetCurrentContext(), Nan::New("Buffer").ToLocalChecked()).ToLocalChecked())',
  ],
  [
    'Object::Set → context-aware (BTSerialPortBinding)',
    'target->Set(Nan::New("BTSerialPortBinding").ToLocalChecked(), t->GetFunction(ctx).ToLocalChecked())',
    'target->Set(ctx, Nan::New("BTSerialPortBinding").ToLocalChecked(), t->GetFunction(ctx).ToLocalChecked())',
  ],
]);

// ── BTSerialPortBindingServer.cc (server — what BluetoothSerialPortServer uses)
console.log('Patching BTSerialPortBindingServer.cc…');
patchFile('BTSerialPortBindingServer.cc', [
  [
    'Object::Get → context-aware (Buffer constructor)',
    'Local<Function>::Cast(globalObj->Get(Nan::New("Buffer").ToLocalChecked()))',
    'Local<Function>::Cast(globalObj->Get(Nan::GetCurrentContext(), Nan::New("Buffer").ToLocalChecked()).ToLocalChecked())',
  ],
  [
    'Object::Set → context-aware (BTSerialPortBindingServer)',
    'target->Set(Nan::New("BTSerialPortBindingServer").ToLocalChecked(), t->GetFunction(ctx).ToLocalChecked())',
    'target->Set(ctx, Nan::New("BTSerialPortBindingServer").ToLocalChecked(), t->GetFunction(ctx).ToLocalChecked())',
  ],
  [
    'Array::Get(Integer) → context-aware',
    'Local<Value>  property = properties->Get(Nan::New<Integer>(i));',
    'Local<Value>  property = properties->Get(Nan::GetCurrentContext(), Nan::New<Integer>(i)).ToLocalChecked();',
  ],
  [
    'Object::Get(property) → context-aware',
    'Local<Value> optionValue = jsOptions->Get(property);',
    'Local<Value> optionValue = jsOptions->Get(Nan::GetCurrentContext(), property).ToLocalChecked();',
  ],
]);

// ── Rebuild ──────────────────────────────────────────────────────────────────
console.log('Rebuilding…');
const MODULE_DIR = path.join(__dirname, '..', 'node_modules', 'bluetooth-serial-port');
execSync('node-gyp configure build', { cwd: MODULE_DIR, stdio: 'inherit' });

console.log('');
console.log('bluetooth-serial-port rebuilt for Node.js 20 ✓');

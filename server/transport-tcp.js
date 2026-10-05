// server/transport-tcp.js
// Debug stand in for the Bluetooth serial server, used only when DEBUG_TCP=1.
// Same small surface the server uses (listen, on, write, close), but carried over
// a TCP port on this machine only (127.0.0.1), so the real server can be driven
// from an SSH session with scripts/phone.js and no phone or Bluetooth.
//
//   DEBUG_TCP=1 node server/index.js          (then, in another SSH session)
//   node scripts/phone.js '{"action":"hello","v":2}'
//
// It listens on localhost only, so nothing on the network can reach it.

'use strict';

const net = require('net');

const PORT = Number(process.env.DEBUG_TCP_PORT || 9000);

class BluetoothSerialPortServer {
  constructor() {
    this._handlers = {};
    this._socket = null;
    this._tcp = null;
  }

  listen(onConnect, onError /* , options */) {
    this._tcp = net.createServer((socket) => {
      if (this._socket) { socket.destroy(); return; } // one phone at a time, like SPP
      this._socket = socket;
      socket.on('data', (chunk) => this._emit('data', chunk));
      socket.on('close', () => {
        this._socket = null;
        // The server makes a new instance after a disconnect, so free the port for it.
        try { this._tcp.close(); } catch { /* already closed */ }
        this._emit('disconnected');
      });
      socket.on('error', () => {});
      onConnect('tcp:' + socket.remoteAddress);
    });
    this._tcp.on('error', (err) => onError && onError(err));
    this._tcp.listen(PORT, '127.0.0.1');
  }

  on(evt, fn) { this._handlers[evt] = fn; }
  _emit(evt, arg) { if (this._handlers[evt]) this._handlers[evt](arg); }

  write(buf, cb) {
    if (!this._socket) { if (cb) cb(new Error('no client')); return; }
    this._socket.write(buf, cb);
  }

  close() {
    if (this._socket) this._socket.destroy();
    if (this._tcp) this._tcp.close();
  }
}

module.exports = { BluetoothSerialPortServer };

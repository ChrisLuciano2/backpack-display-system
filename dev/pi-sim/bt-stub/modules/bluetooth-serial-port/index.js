// Simulation stand-in for the native bluetooth-serial-port module.
// Same surface the server uses (BluetoothSerialPortServer: listen, on, write, close),
// but carried over TCP port 9000 so a fake phone can connect from anywhere.
'use strict';

const net = require('net');

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
        // The real server discards this instance on disconnect and makes a new one,
        // so free the port for it (an SPP channel is released the same way).
        try { this._tcp.close(); } catch { /* already closed */ }
        this._emit('disconnected');
      });
      socket.on('error', () => {});
      onConnect('tcp:' + socket.remoteAddress);
    });
    this._tcp.on('error', (err) => onError && onError(err));
    this._tcp.listen(9000, '0.0.0.0');
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

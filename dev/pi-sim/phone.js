// Fake phone. Speaks the same newline delimited JSON as the real app, over TCP :9000.
//
// CLI:  node phone.js '{"action":"list"}' '{"action":"play","file":"short one.mp4"}'
//       sends each argument, then prints everything the server says for 2 seconds.
// Library: const { Phone } = require('./phone'); used by the scenarios.
'use strict';

const net = require('net');

class Phone {
  constructor(host = '127.0.0.1', port = 9000) {
    this.host = host;
    this.port = port;
    this.messages = [];    // every parsed message received, in order
    this.status = null;    // most recent status message
    this.errors = [];      // every { error } received
    this._buf = '';
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, () => resolve(this));
      this.sock.on('error', reject);
      this.sock.on('data', (chunk) => {
        this._buf += chunk.toString('utf8');
        const lines = this._buf.split('\n');
        this._buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.messages.push(msg);
            if (msg.status) this.status = msg;
            if (msg.error) this.errors.push(msg.error);
          } catch { /* ignore */ }
        }
      });
    });
  }

  send(obj) { this.sock.write(JSON.stringify(obj) + '\n'); }
  close() { this.sock.destroy(); }
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Poll until predicate(status) is true or the time runs out.
  async waitForStatus(pred, ms = 8000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.status && pred(this.status)) return true;
      await this.sleep(100);
    }
    return false;
  }
}

module.exports = { Phone };

if (require.main === module) {
  (async () => {
    const phone = await new Phone().connect();
    await phone.sleep(300);
    for (const arg of process.argv.slice(2)) {
      phone.send(JSON.parse(arg));
      await phone.sleep(100);
    }
    await phone.sleep(2000);
    for (const m of phone.messages) console.log(JSON.stringify(m));
    phone.close();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

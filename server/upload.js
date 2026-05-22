// server/upload.js
// Zero-dependency HTTP upload server (uses only Node.js built-ins).
//
// Endpoints:
//   GET  /ping    → { ok: true }
//   POST /upload  → multipart/form-data with one "file" field
//                 → { ok: true, file: "video.mp4" }  or  { error: "..." }
//
// The parser streams file bytes directly to disk, so large video files
// never need to be fully buffered in RAM.

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { MEDIA_DIR, UPLOAD_PORT } = require('./config');

// Accepted file extensions
const ALLOWED_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm',  // video
  '.gif', '.jpg', '.jpeg', '.png',                   // image
]);

// ── Streaming multipart parser ─────────────────────────────────────────────
//
// Parses the first (and only) file part from a multipart/form-data body.
// Writes file data directly to disk as it arrives — never buffers the whole
// file in memory.  Handles a single file per request.
//
// Multipart wire format (simplified):
//   --{boundary}\r\n
//   Content-Disposition: form-data; name="file"; filename="vid.mp4"\r\n
//   Content-Type: video/mp4\r\n
//   \r\n
//   <binary file data>
//   \r\n--{boundary}--\r\n

function streamUpload(req, res, boundary) {
  const opener  = Buffer.from('--' + boundary + '\r\n');
  const closing = Buffer.from('\r\n--' + boundary + '--');
  const headEnd = Buffer.from('\r\n\r\n');

  let state        = 'preamble'; // preamble → headers → data
  let accum        = Buffer.alloc(0);
  let writeStream  = null;
  let savedName    = null;
  let finished     = false;

  // Send an error response and tear down any open write stream.
  function fail(code, msg) {
    if (finished) return;
    finished = true;
    if (writeStream) writeStream.destroy();
    if (!res.headersSent) {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    console.error('[upload] Error:', msg);
  }

  req.on('data', (chunk) => {
    if (finished) return;
    accum = Buffer.concat([accum, chunk]);

    // ── Preamble: skip everything before the opening boundary ─────────────
    if (state === 'preamble') {
      const idx = accum.indexOf(opener);
      if (idx === -1) return;                // wait for more data
      accum = accum.slice(idx + opener.length);
      state = 'headers';
    }

    // ── Headers: read until \r\n\r\n ──────────────────────────────────────
    if (state === 'headers') {
      const idx = accum.indexOf(headEnd);
      if (idx === -1) return;               // wait for more data

      const headersText = accum.slice(0, idx).toString('utf8');
      accum = accum.slice(idx + headEnd.length);

      // Extract filename from Content-Disposition
      const m = headersText.match(/filename="([^"]+)"/i);
      if (!m) { fail(400, 'No filename in Content-Disposition'); return; }

      const filename = path.basename(m[1]);
      const ext      = path.extname(filename).toLowerCase();

      if (!ALLOWED_EXTS.has(ext)) {
        fail(400, `File type "${ext}" is not allowed`);
        return;
      }

      if (!fs.existsSync(MEDIA_DIR)) {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
      }

      const dest = path.join(MEDIA_DIR, filename);
      savedName  = filename;
      writeStream = fs.createWriteStream(dest);
      writeStream.on('error', (err) => fail(500, 'Write error: ' + err.message));
      console.log(`[upload] Receiving "${filename}" → ${dest}`);
      state = 'data';
    }

    // ── Data: pipe to file, keeping closing.length bytes as a rolling tail
    //    so we can strip the closing boundary when the request ends ─────────
    if (state === 'data' && !finished) {
      if (accum.length > closing.length) {
        writeStream.write(accum.slice(0, accum.length - closing.length));
        accum = accum.slice(accum.length - closing.length);
      }
    }
  });

  req.on('end', () => {
    if (finished) return;
    if (state !== 'data' || !writeStream) { fail(400, 'Incomplete upload'); return; }

    // accum = [possible extra file bytes] + closing boundary + optional epilogue
    const closeIdx = accum.indexOf(closing);
    if (closeIdx > 0) {
      writeStream.write(accum.slice(0, closeIdx));
    } else if (closeIdx < 0) {
      // Malformed — write whatever is left
      if (accum.length > 0) writeStream.write(accum);
    }
    // closeIdx === 0: nothing to write before the closing marker

    writeStream.end();

    writeStream.on('finish', () => {
      if (finished) return;
      finished = true;
      // Report file size
      try {
        const { size } = fs.statSync(path.join(MEDIA_DIR, savedName));
        console.log(`[upload] Saved "${savedName}" (${(size / 1e6).toFixed(1)} MB)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: savedName, size }));
      } catch (err) {
        fail(500, 'Stat error: ' + err.message);
      }
    });
  });

  req.on('error', (err) => fail(500, 'Request error: ' + err.message));
}

// ── HTTP server ────────────────────────────────────────────────────────────

function startUploadServer() {
  const server = http.createServer((req, res) => {
    // Allow cross-origin requests from the phone app
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── GET /ping ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── POST /upload ──────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/upload') {
      const ct = req.headers['content-type'] || '';
      const bm = ct.match(/boundary=([^\s;]+)/i);
      if (!bm) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing multipart boundary' }));
        return;
      }
      streamUpload(req, res, bm[1]);
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(UPLOAD_PORT, '0.0.0.0', () => {
    console.log(`[upload] HTTP server listening on :${UPLOAD_PORT}`);
  });

  server.on('error', (err) => {
    console.error('[upload] Server error:', err.message);
  });

  return server;
}

module.exports = { startUploadServer };

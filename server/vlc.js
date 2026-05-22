// server/vlc.js
// Wrapper around VLC's built-in HTTP API
//
// VLC must be running before the server starts. Launch it with:
//   vlc --intf dummy --extraintf http \
//       --http-password backpack --http-port 8080 \
//       --fullscreen --no-video-title-show
//
// VLC volume scale:  0–512  where 256 = 100%
// Protocol volume:   0–100  (percentage)

'use strict';

const http = require('http');
const { VLC_HOST, VLC_PORT, VLC_PASSWORD } = require('./config');

// Basic auth header — VLC uses empty username + password
const AUTH_HEADER = 'Basic ' + Buffer.from(':' + VLC_PASSWORD).toString('base64');

const STATUS_PATH  = '/requests/status.json';

// ── Low-level HTTP request ────────────────────────────────────────────────────

function vlcGet(params = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString()
      : '';

    const options = {
      host:    VLC_HOST,
      port:    VLC_PORT,
      path:    STATUS_PATH + qs,
      headers: { Authorization: AUTH_HEADER },
      timeout: 3000,
    };

    const req = http.get(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({}); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('VLC request timed out')); });
    req.on('error',   (err) => reject(err));
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Clamp a value to [min, max]
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// Convert protocol 0-100 → VLC 0-256
function toVlcVol(pct) { return Math.round(clamp(pct, 0, 100) * 2.56); }

// Convert VLC 0-512 → protocol 0-100
function fromVlcVol(vlcVol) { return Math.round(clamp(vlcVol, 0, 512) / 2.56); }

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
  // Raw VLC state object (for building status payloads)
  async rawStatus() {
    return vlcGet();
  },

  // Build the protocol status payload from VLC state
  async buildStatus(includeFiles) {
    const s = await vlcGet();
    const payload = {
      status:   s.state  || 'stopped',         // 'playing' | 'paused' | 'stopped'
      file:     s.information?.category?.meta?.filename || null,
      pos:      Math.round(s.time   || 0),      // seconds elapsed
      duration: Math.round(s.length || 0),      // total seconds
      volume:   fromVlcVol(s.volume || 0),      // 0-100
    };
    if (includeFiles) {
      // Caller is responsible for populating payload.files
      payload.files = [];
    }
    return payload;
  },

  // Play a specific file (absolute path on Pi filesystem).
  // isImage: true for .gif/.jpg/.png — tells VLC to hold the image
  // indefinitely (-1) instead of the default 10-second timeout, and
  // to loop GIFs continuously.
  async playFile(absolutePath, isImage = false) {
    const uri = 'file://' + absolutePath;
    if (isImage) {
      // image-duration=-1 : display forever until stopped
      // input-repeat=65535: loop GIF animation continuously
      return vlcGet({
        command: 'in_play',
        input: uri,
        option: 'image-duration=-1 :input-repeat=65535',
      });
    }
    return vlcGet({ command: 'in_play', input: uri });
  },

  // Pause (if playing) — VLC toggles with pl_pause
  async pause() {
    return vlcGet({ command: 'pl_forcepause' });
  },

  // Resume (if paused) — VLC toggles with pl_forceresume
  async resume() {
    return vlcGet({ command: 'pl_forceresume' });
  },

  // Stop playback
  async stop() {
    return vlcGet({ command: 'pl_stop' });
  },

  // Skip to next item in VLC playlist
  async next() {
    return vlcGet({ command: 'pl_next' });
  },

  // Go back to previous item in VLC playlist
  async prev() {
    return vlcGet({ command: 'pl_previous' });
  },

  // Set volume, pct is 0-100
  async setVolume(pct) {
    return vlcGet({ command: 'volume', val: toVlcVol(pct) });
  },

  // Seek to an absolute position in seconds
  async seek(seconds) {
    return vlcGet({ command: 'seek', val: Math.round(seconds) });
  },

  // Set display fit mode for current media
  //   'contain'  → letterbox/pillarbox, black bars, original aspect ratio preserved
  //   'cover'    → crop to fill the screen (no black bars, edges trimmed)
  //   'stretch'  → force 16:9, may distort non-16:9 content
  async setDisplayMode(mode) {
    if (mode === 'contain') {
      // Reset both crop and aspect ratio override back to VLC defaults
      await vlcGet({ command: 'crop',        val: 'None' });
      await vlcGet({ command: 'aspectratio', val: 'None' });
    } else if (mode === 'cover') {
      // Crop video content to 16:9 — fills the screen, trims edges
      await vlcGet({ command: 'crop', val: '16:9' });
    } else if (mode === 'stretch') {
      // Force 16:9 aspect ratio — stretches non-16:9 content to fill screen
      await vlcGet({ command: 'aspectratio', val: '16:9' });
    }
  },

  // Check if VLC HTTP API is reachable (used at startup)
  async ping() {
    try {
      const s = await vlcGet();
      return !!s.state;
    } catch {
      return false;
    }
  },
};

// server/media.js
// Scans the Pi's media directory and resolves filenames to full paths.
// The phone only ever sees bare filenames (no path) — all path logic stays here.

'use strict';

const fs   = require('fs');
const path = require('path');
const { MEDIA_DIR, MEDIA_EXTS } = require('./config');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a sorted array of playable filenames in MEDIA_DIR.
 * Creates the directory if it doesn't exist yet.
 * Returns [] on any error.
 */
function listFiles() {
  try {
    if (!fs.existsSync(MEDIA_DIR)) {
      console.log('[media] Creating media directory:', MEDIA_DIR);
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
    }

    return fs.readdirSync(MEDIA_DIR)
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return MEDIA_EXTS.includes(ext);
      })
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  } catch (err) {
    console.error('[media] Error listing files:', err.message);
    return [];
  }
}

/**
 * Resolves a bare filename (e.g. "movie.mp4") to its full absolute path on disk.
 * Returns null if the file doesn't exist in MEDIA_DIR.
 */
function resolveFile(filename) {
  const files = listFiles();
  const match = files.find((f) => f === filename);
  if (!match) return null;
  return path.join(MEDIA_DIR, match);
}

/**
 * Returns true if the given filename exists in MEDIA_DIR.
 */
function fileExists(filename) {
  return resolveFile(filename) !== null;
}

module.exports = { listFiles, resolveFile, fileExists };

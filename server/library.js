// server/library.js
// The game library: scans the games folder, gives every game a stable id, says
// which systems can actually run, and resolves an id back to a real path.
//
// The phone never sends a path. It sends an id that this module made, and the id
// is only ever looked up in this module's own scan. An id that is not in the scan
// resolves to nothing, so a hostile string can never reach a file path or a command.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const defaultSystems = require('./systems.json');
const { ROMS_DIR, CORES_DIR, BIOS_DIR } = require('./config');

const MAX_DEPTH = 2;      // roms/<system>/<game> and one folder level (disc games in a folder)
const MAX_PAGE = 100;

function idFor(systemId, relPath) {
  return systemId + ':' + crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 12);
}

function createLibrary({ romsDir = ROMS_DIR, coresDir = CORES_DIR, biosDir = BIOS_DIR, systems = defaultSystems } = {}) {
  const systemIds = Object.keys(systems).filter((k) => !k.startsWith('_'));
  const known = (id) => typeof id === 'string' && systemIds.includes(id); // never trust object lookups: '__proto__' is a key
  const cache = new Map();   // systemId -> { stamp, games: [] }
  const byId = new Map();    // gameId -> game (rebuilt on scan)

  function existingDirs(sys) {
    return sys.dirs.map((d) => path.join(romsDir, d)).filter((d) => {
      try { return fs.statSync(d).isDirectory(); } catch { return false; }
    });
  }

  // A cheap fingerprint of the folders: changes when a file is added or removed.
  function stampFor(dirs) {
    return dirs.map((d) => {
      try { return d + ':' + fs.statSync(d).mtimeMs; } catch { return d + ':gone'; }
    }).join('|');
  }

  function walk(dir, depth, exts, out, baseDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1, exts, out, baseDir);
      } else if (exts.has(path.extname(e.name).toLowerCase())) {
        out.push({ full, rel: path.relative(baseDir, full) });
      }
    }
  }

  function scan(systemId) {
    const sys = systems[systemId];
    const dirs = existingDirs(sys);
    const stamp = stampFor(dirs);
    const hit = cache.get(systemId);
    if (hit && hit.stamp === stamp) return hit.games;

    const exts = new Set(sys.extensions.map((x) => x.toLowerCase()));
    const found = [];
    for (const d of dirs) walk(d, 0, exts, found, romsDir);

    const games = found.map((f) => {
      let size = 0;
      try { size = fs.statSync(f.full).size; } catch { /* vanished */ }
      const file = path.basename(f.full);
      return {
        id: idFor(systemId, f.rel.split(path.sep).join('/')),
        name: file.slice(0, file.length - path.extname(file).length),
        system: systemId,
        sizeMB: Math.round((size / 1048576) * 10) / 10,
        _path: f.full,
      };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    cache.set(systemId, { stamp, games });
    for (const g of games) byId.set(g.id, g);
    return games;
  }

  function coreFor(sys) {
    return path.join(coresDir, sys.core);
  }

  function biosOk(sys) {
    if (!sys.biosRequired) return true;
    return sys.bios.some((b) => { try { return fs.statSync(path.join(biosDir, b)).isFile(); } catch { return false; } });
  }

  function readiness(systemId) {
    const sys = systems[systemId];
    let coreThere = false;
    try { coreThere = fs.statSync(coreFor(sys)).isFile(); } catch { /* missing */ }
    if (!coreThere) return 'no_core';
    if (!biosOk(sys)) return 'needs_bios';
    if (scan(systemId).length === 0) return 'empty';
    return 'ready';
  }

  return {
    // Every system with its state, for the console picker.
    systems() {
      return systemIds.map((id) => {
        const sys = systems[id];
        return {
          id, name: sys.name, media: sys.media, verified: !!sys.verified,
          ready: readiness(id), games: scan(id).length,
        };
      });
    },

    // One page of games. Public fields only, never a path.
    list(systemId, page = 0, size = 50) {
      if (!known(systemId)) return null;
      const n = Math.min(Math.max(parseInt(size, 10) || 50, 1), MAX_PAGE);
      const p = Math.max(parseInt(page, 10) || 0, 0);
      const games = scan(systemId);
      const items = games.slice(p * n, p * n + n).map(({ _path, ...pub }) => pub);
      return { system: systemId, ready: readiness(systemId), total: games.length, page: p, size: n, items };
    },

    // id -> { id, name, system, core, rom } or null. The only way a game becomes a path.
    resolve(gameId) {
      if (typeof gameId !== 'string' || !/^[a-z0-9_]+:[0-9a-f]{12}$/.test(gameId)) return null;
      const systemId = gameId.split(':')[0];
      if (!known(systemId)) return null;
      const sys = systems[systemId];

      let game = byId.get(gameId);
      if (!game || !fs.existsSync(game._path)) {
        scan(systemId);                    // files may have been added or removed
        game = byId.get(gameId);
      }
      if (!game || !fs.existsSync(game._path)) return null;

      // Refuse anything that resolves outside the games folder (a symlink, say).
      let real, root;
      try { real = fs.realpathSync(game._path); root = fs.realpathSync(romsDir); } catch { return null; }
      if (!real.startsWith(root + path.sep)) return null;

      if (readiness(systemId) === 'no_core' || readiness(systemId) === 'needs_bios') return null;
      return { id: game.id, name: game.name, system: systemId, core: coreFor(sys), rom: game._path };
    },

    // Why a game cannot be launched, for a plain message to the phone.
    whyNot(gameId) {
      const systemId = typeof gameId === 'string' ? gameId.split(':')[0] : '';
      if (!known(systemId)) return 'invalid_id';
      const r = readiness(systemId);
      if (r === 'no_core') return 'no_core';
      if (r === 'needs_bios') return 'needs_bios';
      return 'invalid_id';
    },
  };
}

module.exports = { createLibrary, idFor };

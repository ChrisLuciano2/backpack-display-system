'use strict';

// server/system.js: storage and power/thermal health (STG452-63).
//
// Requirements (PRD):
//   FR-11  The phone shows storage used and warns at 70 percent (amber) and 90 percent (red).
//   FR-16  The server watches temperature, throttle flags and undervoltage. The app shows a
//          warning when any trips.
// Design (Design Doc sections 12 and 13):
//   - storage numbers come from the ROM and media mounts, like `df`;
//   - every 5 s sample `vcgencmd measure_temp` and `vcgencmd get_throttled`;
//   - bit 0 (0x1) is under-voltage now, bit 2 (0x4) is throttled now, bit 3 (0x8) is the soft
//     temperature limit now; warn at 75 C or when any of those bits is set.
//
// Everything that touches the real Pi (vcgencmd, the thermal file, the filesystem) is a reader
// function that can be replaced, so the logic is tested on any machine. Readers may fail, for
// example on a laptop with no vcgencmd; that makes the field null and never throws.

const fs = require('fs');
const { execFile } = require('child_process');

const STORAGE_AMBER_PERCENT = 70;
const STORAGE_RED_PERCENT = 90;
const TEMP_WARN_C = 75;
const SAMPLE_INTERVAL_MS = 5000;
const EVENT_HISTORY = 20;
const GB = 1024 * 1024 * 1024;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** "temp=52.1'C" -> 52.1, or null if it is not a temperature. */
function parseTemp(text) {
  const m = /temp=(-?\d+(?:\.\d+)?)/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** "throttled=0x50005" -> 0x50005, or null. */
function parseThrottled(text) {
  const m = /throttled=(0x[0-9a-fA-F]+)/.exec(String(text || ''));
  return m ? parseInt(m[1], 16) : null;
}

/** Decode the get_throttled bit field. The "now" bits are 0 to 3, the "has occurred" bits are 16 to 19. */
function decodeThrottled(value) {
  const v = Number(value) || 0;
  const bit = (n) => (v & (1 << n)) !== 0;
  return {
    undervolt: bit(0),
    armCapped: bit(1),
    throttled: bit(2),
    softTempLimit: bit(3),
    undervoltOccurred: bit(16),
    armCappedOccurred: bit(17),
    throttledOccurred: bit(18),
    softTempLimitOccurred: bit(19),
  };
}

/** FR-11: 'ok' below 70 percent, 'amber' from 70, 'red' from 90. */
function storageLevel(percent) {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return null;
  if (percent >= STORAGE_RED_PERCENT) return 'red';
  if (percent >= STORAGE_AMBER_PERCENT) return 'amber';
  return 'ok';
}

const LEVEL_RANK = { ok: 0, amber: 1, red: 2 };

// ── Real readers (these are the only parts that need a Pi) ────────────────────

function runVcgencmd(args) {
  return new Promise((resolve, reject) => {
    execFile('vcgencmd', args, { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function readTempReal() {
  try {
    const t = parseTemp(await runVcgencmd(['measure_temp']));
    if (t !== null) return t;
  } catch { /* fall through to the kernel's thermal file */ }
  const raw = await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
  const milli = Number(String(raw).trim());
  return Number.isFinite(milli) ? milli / 1000 : null;
}

async function readThrottledReal() {
  return parseThrottled(await runVcgencmd(['get_throttled']));
}

/** df style numbers for one path: used / (used + available), the way `df` computes Use%. */
async function readStorageReal(p) {
  const s = await fs.promises.statfs(p);
  const total = s.blocks * s.bsize;
  const free = s.bfree * s.bsize;
  const avail = s.bavail * s.bsize;
  const used = total - free;
  const denom = used + avail;
  return { path: p, totalBytes: total, usedBytes: used, percent: denom > 0 ? (used / denom) * 100 : 0 };
}

// ── The monitor ───────────────────────────────────────────────────────────────

/**
 * options:
 *   storagePaths   paths whose mount to measure (the worst one is reported)
 *   readTemp, readThrottled, readStorage   replaceable readers (tests inject fakes)
 *   intervalMs     how often start() samples (default 5 s)
 *   tempWarnC      temperature that trips the banner (default 75 C)
 *   now            clock, for the event log
 *   onEvent        called once when a warning appears or clears
 */
function createMonitor(options = {}) {
  const storagePaths = options.storagePaths || [];
  const readTemp = options.readTemp || readTempReal;
  const readThrottled = options.readThrottled || readThrottledReal;
  const readStorage = options.readStorage || readStorageReal;
  const intervalMs = options.intervalMs || SAMPLE_INTERVAL_MS;
  const tempWarnC = options.tempWarnC === undefined ? TEMP_WARN_C : options.tempWarnC;
  const now = options.now || (() => new Date());
  const onEvent = options.onEvent || (() => {});

  let last = null;               // last snapshot
  let active = new Map();        // warning code -> level, for edge detection
  const events = [];             // newest last, capped
  let timer = null;
  let sampling = null;

  function record(kind, w) {
    const e = { at: now().toISOString(), kind, code: w.code, level: w.level, message: w.message };
    events.push(e);
    while (events.length > EVENT_HISTORY) events.shift();
    try { onEvent(e); } catch { /* a listener must not break sampling */ }
  }

  async function safe(fn, arg) {
    try { return await fn(arg); } catch { return null; }
  }

  async function sample() {
    const [tempC, throttledRaw] = await Promise.all([safe(readTemp), safe(readThrottled)]);

    // Storage: measure every path, report the worst mount.
    const readings = [];
    for (const p of storagePaths) {
      const r = await safe(readStorage, p);
      if (r) readings.push(r);
    }
    readings.sort((a, b) => b.percent - a.percent);
    const worst = readings[0] || null;
    const storage = worst
      ? {
          path: worst.path,
          usedGB: Math.round((worst.usedBytes / GB) * 10) / 10,
          totalGB: Math.round((worst.totalBytes / GB) * 10) / 10,
          percent: Math.round(worst.percent * 10) / 10,
          level: storageLevel(worst.percent),
        }
      : null;

    const flags = throttledRaw === null ? null : decodeThrottled(throttledRaw);
    const warnings = [];
    if (storage && storage.level !== 'ok') {
      warnings.push({
        code: 'storage_' + storage.level,
        level: storage.level,
        message: `Storage is ${storage.percent} percent full (${storage.usedGB} of ${storage.totalGB} GB).`,
      });
    }
    if (flags && flags.undervolt) warnings.push({ code: 'undervolt', level: 'red', message: 'Under-voltage right now: check the power supply and battery pack.' });
    if (flags && flags.throttled) warnings.push({ code: 'throttled', level: 'red', message: 'The Pi is being throttled right now.' });
    if (flags && flags.softTempLimit) warnings.push({ code: 'soft_temp_limit', level: 'amber', message: 'The Pi has reached its soft temperature limit.' });
    if (tempC !== null && tempC >= tempWarnC) warnings.push({ code: 'temp_high', level: 'amber', message: `Temperature is ${tempC} C (warning at ${tempWarnC} C).` });

    // Edge detection: log a warning when it appears, and when it clears.
    const nowActive = new Map(warnings.map((w) => [w.code, w.level]));
    for (const w of warnings) if (!active.has(w.code)) record('warning', w);
    for (const [code, level] of active) {
      if (!nowActive.has(code)) record('cleared', { code, level, message: 'Back to normal.' });
    }
    active = nowActive;

    const worstLevel = warnings.reduce((m, w) => (LEVEL_RANK[w.level] > LEVEL_RANK[m] ? w.level : m), 'ok');
    last = {
      sampledAt: now().toISOString(),
      storage,
      health: {
        tempC,
        throttled: throttledRaw === null ? null : '0x' + throttledRaw.toString(16),
        undervolt: flags ? flags.undervolt : null,
        occurred: flags
          ? { undervolt: flags.undervoltOccurred, throttled: flags.throttledOccurred, softTempLimit: flags.softTempLimitOccurred }
          : null,
        level: worstLevel,
        warnings,
      },
    };
    return last;
  }

  /** One sample at a time: a slow vcgencmd must not stack up calls. */
  function refresh() {
    if (!sampling) sampling = sample().finally(() => { sampling = null; });
    return sampling;
  }

  return {
    sample: refresh,
    snapshot: () => last,
    events: () => events.slice(),
    start() {
      if (timer) return;
      refresh().catch(() => {});
      timer = setInterval(() => refresh().catch(() => {}), intervalMs);
      if (timer.unref) timer.unref();   // never keep the process alive just for monitoring
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = {
  createMonitor,
  parseTemp,
  parseThrottled,
  decodeThrottled,
  storageLevel,
  STORAGE_AMBER_PERCENT,
  STORAGE_RED_PERCENT,
  TEMP_WARN_C,
};

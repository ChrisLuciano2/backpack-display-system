#!/usr/bin/env node
'use strict';

// Demo of the storage and health monitor (STG452-79) with SIMULATED sensors.
// It runs the real server/system.js through a scripted scenario and prints what the phone
// would be told at each step. Nothing here is measured on a Pi: on a Pi, run the server and
// send {"action":"health"} to see the real values (that is STG452-77).
//
//   node scripts/health-demo.js

const { createMonitor } = require('../server/system');

const GB = 1024 * 1024 * 1024;
const sensors = { temp: 52, throttled: 0, percent: 31 };

const monitor = createMonitor({
  storagePaths: ['/home/pi/roms'],
  readTemp: async () => sensors.temp,
  readThrottled: async () => sensors.throttled,
  readStorage: async (p) => ({ path: p, totalBytes: 128 * GB, usedBytes: (128 * GB * sensors.percent) / 100, percent: sensors.percent }),
  now: (() => { let t = Date.parse('2026-11-15T20:00:00Z'); return () => new Date((t += 5000)); })(),
});

const steps = [
  ['1. Everything normal',                          { temp: 52, throttled: 0x0,     percent: 31 }],
  ['2. Storage fills to 72 percent (FR-11 amber)',  { temp: 53, throttled: 0x0,     percent: 72 }],
  ['3. Storage 91, under-voltage, 78 C (FR-11 red, FR-16)', { temp: 78, throttled: 0x1, percent: 91 }],
  ['4. Past event only: under-voltage earlier, none now', { temp: 60, throttled: 0x50000, percent: 40 }],
  ['5. Back to normal',                              { temp: 50, throttled: 0x0,     percent: 40 }],
];

(async () => {
  console.log('SIMULATED SENSORS: real server/system.js, fake readings\n');
  for (const [title, values] of steps) {
    Object.assign(sensors, values);
    const s = await monitor.sample();
    console.log(title);
    console.log(`  sensors : temp ${values.temp} C, get_throttled 0x${values.throttled.toString(16)}, storage ${values.percent}%`);
    console.log(`  phone   : storage ${s.storage.usedGB}/${s.storage.totalGB} GB (${s.storage.level}), health ${s.health.level}`);
    if (s.health.warnings.length) for (const w of s.health.warnings) console.log(`            BANNER [${w.level}] ${w.message}`);
    else console.log('            no banner');
    const occ = s.health.occurred;
    if (occ && (occ.undervolt || occ.throttled || occ.softTempLimit)) console.log('            history note: under-voltage/throttling happened earlier since boot');
    console.log('');
  }
  console.log('event log (the last times a warning appeared or cleared):');
  for (const e of monitor.events()) console.log(`  ${e.at}  ${e.kind.padEnd(7)} ${e.code} (${e.level})`);
})();

#!/usr/bin/env node
// Launch-video soundtrack, synthesized sample by sample (nothing to license):
// a driving 120 BPM track (Am - F - C - G) with sidechain pumping, plus sound
// effects at the cue times exported by scenes.js.
//
//   node soundtrack.mjs <cues.json> <out.wav> <seconds>

import fs from 'node:fs';

const [cuesFile, out, secondsArg] = process.argv.slice(2);
const cues = JSON.parse(fs.readFileSync(cuesFile, 'utf8'));
const SR = 48000;
const SEC = Number(secondsArg);
const N = Math.round(SEC * SR);
const BEAT = 0.5, BAR = 2;
const music = [new Float32Array(N), new Float32Array(N)];
const pumped = [new Float32Array(N), new Float32Array(N)]; // ducked by the kick
const sfx = [new Float32Array(N), new Float32Array(N)];

let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
function put(bus, t0, dur, fn, pan = 0) {
  const s0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  const gl = Math.min(1, 1 - pan), gr = Math.min(1, 1 + pan);
  for (let i = 0; i < n; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const v = fn(i / SR, i);
    bus[0][k] += v * gl;
    bus[1][k] += v * gr;
  }
}
const sin = (f, t) => Math.sin(2 * Math.PI * f * t);
const saw = (f, t) => 2 * ((f * t) % 1) - 1;

// ------------------------------------------------------------- instruments
const kicks = [];
function kick(t0, amp = 1) {
  kicks.push(t0);
  let ph = 0;
  put(music, t0, 0.45, (t) => {
    const f = 45 + 120 * Math.exp(-t * 32);
    ph += (2 * Math.PI * f) / SR;
    const click = t < 0.004 ? rnd() * 0.4 : 0;
    return (Math.tanh(Math.sin(ph) * 2.2) * Math.exp(-t * 6.5) + click) * 0.85 * amp;
  });
}
function clap(t0, amp = 1) {
  let lp = 0;
  put(music, t0, 0.3, (t) => {
    const n = rnd(); lp += 0.3 * (n - lp);
    const bursts = t < 0.03 ? (Math.floor(t * 300) % 3 === 0 ? 1 : 0.4) : 1;
    return (n - lp) * Math.exp(-t * 16) * bursts * 0.42 * amp;
  });
}
function hat(t0, open = false, amp = 1, pan = 0.3) {
  let prev = 0;
  put(music, t0, open ? 0.22 : 0.05, (t) => {
    const n = rnd(); const hp = n - prev; prev = n;
    return hp * Math.exp(-t * (open ? 14 : 80)) * (open ? 0.13 : 0.09) * amp;
  }, pan);
}
function bass(t0, f, dur) {
  put(pumped, t0, dur, (t) => {
    const env = Math.min(1, t * 120) * Math.min(1, (dur - t) * 40);
    const v = 0.6 * sin(f, t) + 0.35 * Math.tanh(saw(f, t) * 1.5) * Math.exp(-t * 5);
    return v * env * 0.34;
  });
}
function pad(t0, freqs, dur, amp = 0.05) {
  put(pumped, t0, dur, (t) => {
    const env = Math.min(1, t / 0.08) * Math.min(1, (dur - t) / 0.15);
    let v = 0;
    for (const f of freqs) for (const d of [0.996, 1.004]) v += saw(f * d, t) * 0.5;
    return v * env * amp * 0.5;
  }, 0);
}
function pluck(t0, f, amp = 0.09, pan = 0) {
  put(music, t0, 0.35, (t) => (sin(f, t) + 0.4 * sin(f * 2, t) * Math.exp(-t * 20)) * Math.exp(-t * 11) * amp, pan);
}

// ------------------------------------------------------------- arrangement (23 bars)
const CH = [
  { pad: [220, 261.63, 329.63], root: 55, arp: [440, 523.25, 659.25, 880] },
  { pad: [174.61, 220, 261.63], root: 43.65, arp: [349.23, 440, 523.25, 698.46] },
  { pad: [261.63, 329.63, 392], root: 65.41, arp: [523.25, 659.25, 783.99, 1046.5] },
  { pad: [196, 246.94, 293.66], root: 49, arp: [392, 493.88, 587.33, 783.99] },
];
const bars = Math.ceil(SEC / BAR);
for (let b = 0; b < bars; b++) {
  const t = b * BAR, c = CH[b % 4];
  const intro = b < 2;           // 0–4 s: hook, sparse
  const lift = b === 2;          // 4–6 s: "Now they can."
  const finale = b >= 20;        // 40–46 s: CTA
  const end = b >= 21;
  const fillBar = b === 19;      // 38–40 s: build before the CTA
  pad(t, c.pad, BAR, intro ? 0.03 : end ? 0.05 : 0.045);
  for (let i = 0; i < 16; i++) {
    const tt = t + i * BEAT / 2;
    const beat = i % 2 === 0, q = i / 2;
    // arp
    if (!end || q < 2) pluck(tt, c.arp[i % 4] * (i % 8 >= 4 ? 1 : 0.5), intro ? 0.07 : 0.06, i % 2 ? 0.35 : -0.35);
    if (intro) { if (b === 1 && !beat) hat(tt, false, 0.6); continue; }
    if (end && q >= 1) continue;
    if (fillBar && q >= 3.5) continue; // a breath before the drop
    if (beat) kick(tt, lift && q === 0 ? 1.1 : 1);
    if (beat && (q === 1 || q === 3) && !lift) clap(tt);
    hat(tt, !beat, beat ? 0.5 : 1, beat ? -0.3 : 0.3);
    if (!lift) bass(tt, c.root * (i % 4 === 3 ? 2 : 1), BEAT / 2 * 0.9);
  }
  if (fillBar) for (let i = 0; i < 8; i++) clap(t + 1.0 + i * 0.0625 * (i < 4 ? 2 : 1), 0.3 + i * 0.08);
}
// final chord rings out
pad(SEC - 4, CH[0].pad, 4, 0.05);
put(music, SEC - 4, 4, (t) => sin(55, t) * Math.exp(-t * 0.8) * 0.25);

// ------------------------------------------------------------- sound effects
const NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];
for (const c of cues) {
  switch (c.type) {
    case 'pop': {
      const f = NOTES[(c.pitch ?? 0) % NOTES.length];
      put(sfx, c.t, 0.18, (t) => (sin(f * (1 + 0.6 * Math.exp(-t * 40)), t)) * Math.exp(-t * 22) * (c.soft ? 0.12 : 0.22));
      break;
    }
    case 'whoosh': {
      let lp = 0;
      put(sfx, c.t - 0.25, 0.55, (t) => {
        const n = rnd(); const a = 0.02 + 0.25 * Math.sin(Math.PI * Math.min(1, t / 0.55)); lp += a * (n - lp);
        return lp * Math.sin(Math.PI * Math.min(1, t / 0.55)) * 0.55;
      });
      break;
    }
    case 'riser': {
      let lp = 0;
      put(sfx, c.t, c.dur, (t) => {
        const k = t / c.dur; const n = rnd(); lp += (0.01 + 0.3 * k * k) * (n - lp);
        return (lp * 0.5 + saw(200 + 600 * k * k, t) * 0.02) * k * k * 0.6;
      });
      break;
    }
    case 'impact':
    case 'boom': {
      let ph = 0;
      put(sfx, c.t, 1.4, (t) => {
        const f = 38 + 90 * Math.exp(-t * 12); ph += (2 * Math.PI * f) / SR;
        return (Math.sin(ph) * Math.exp(-t * 2.6) * 0.7 + rnd() * Math.exp(-t * 18) * 0.25) * (c.type === 'boom' ? 1 : 0.8);
      });
      break;
    }
    case 'glitch':
      put(sfx, c.t, 0.35, (t) => (Math.sign(sin(70 + 30 * Math.floor(t * 40) % 3 * 10, t)) * 0.08 + rnd() * 0.03) * Math.exp(-t * 5) * (Math.floor(t * 30) % 2 ? 1 : 0.3));
      break;
    case 'ding':
      put(sfx, c.t, 0.9, (t) => (sin(1318.5, t) * 0.6 + sin(1975.5, t) * 0.25) * Math.exp(-t * 5) * 0.16, 0.2);
      break;
    case 'tick':
      put(sfx, c.t, 0.05, (t) => rnd() * Math.exp(-t * 120) * 0.25);
      break;
    case 'typing':
      for (let k = 0; k < c.dur / 0.07; k++) {
        const tt = c.t + k * 0.07 + (rnd() * 0.015);
        put(sfx, tt, 0.03, (t) => rnd() * Math.exp(-t * 200) * 0.12, rnd() * 0.3);
      }
      break;
    case 'scramble':
    case 'unscramble':
      put(sfx, c.t, 0.45, (t) => {
        const step = Math.floor(t * 40);
        const f = c.type === 'scramble' ? 600 + ((step * 7919) % 13) * 90 : 1600 - step * 40;
        return Math.sign(sin(f, t)) * 0.035 * Math.exp(-t * 4);
      }, 0.1);
      break;
    case 'swoosh': {
      let lp = 0;
      put(sfx, c.t, 0.6, (t) => { const n = rnd(); lp += 0.08 * (n - lp); return lp * Math.sin(Math.PI * t / 0.6) * 0.35; });
      break;
    }
  }
}

// ------------------------------------------------------------- mix: sidechain, master, write
const duck = new Float32Array(N).fill(1);
for (const k of kicks) {
  const s0 = Math.round(k * SR);
  for (let i = 0; i < SR * 0.4 && s0 + i < N; i++) {
    const d = 1 - 0.7 * Math.exp(-i / SR * 9);
    if (d < duck[s0 + i]) duck[s0 + i] = d;
  }
}
const L = new Float32Array(N), R = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = Math.min(1, t / 0.3) * Math.min(1, (SEC - t) / 1.8);
  for (const [o, ch] of [[L, 0], [R, 1]]) {
    const m = (music[ch][i] + pumped[ch][i] * duck[i]) * 0.9 + sfx[ch][i];
    o[i] = Math.tanh(m * 1.2) * fade;
    peak = Math.max(peak, Math.abs(o[i]));
  }
}
const g = 0.89 / (peak || 1);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
}
fs.writeFileSync(out, buf);
console.log(`${out}: ${SEC}s, ${cues.length} cues`);

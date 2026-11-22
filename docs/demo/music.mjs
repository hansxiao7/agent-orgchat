#!/usr/bin/env node
// Synthesizes the demo soundtrack: a short, calm 120 BPM beat (Am - F - C - G),
// generated sample by sample, so there are no licensing questions.
//
//   node docs/demo/music.mjs <out.wav> <seconds> [introBars=2] [outroBars=2]
//
// Bars are 2 s at 120 BPM; the video cuts on bar lines.

import fs from 'node:fs';

const [out, secondsArg, introArg, outroArg] = process.argv.slice(2);
const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const seconds = Number(secondsArg);
const introBars = Number(introArg ?? 2);
const outroBars = Number(outroArg ?? 2);
const totalBars = Math.ceil(seconds / BAR);
const N = Math.round(seconds * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function add(startSec, durSec, fn, panL = 1, panR = 1) {
  const s0 = Math.round(startSec * SR);
  const n = Math.round(durSec * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const v = fn(i / SR, i);
    L[s0 + i] += v * panL;
    R[s0 + i] += v * panR;
  }
}

function kick(t0) {
  let phase = 0;
  add(t0, 0.4, (t) => {
    const f = 48 + 90 * Math.exp(-t * 35);
    phase += (2 * Math.PI * f) / SR;
    return Math.sin(phase) * Math.exp(-t * 7) * 0.9;
  });
}

function clap(t0) {
  let lp = 0;
  add(t0, 0.25, (t) => {
    const n = rand();
    lp += 0.25 * (n - lp);
    const env = Math.exp(-t * 22) * (t < 0.012 ? 0.6 : 1);
    return (n - lp) * env * 0.32;
  });
}

function hat(t0, amp = 0.07, pan = 0.8) {
  let prev = 0;
  add(t0, 0.06, (t) => {
    const n = rand();
    const hp = n - prev;
    prev = n;
    return hp * Math.exp(-t * 70) * amp;
  }, pan, 2 - pan);
}

function bass(t0, f, dur) {
  add(t0, dur, (t) => {
    const env = Math.min(1, t * 80) * Math.exp(-t * 2.2);
    return (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * env * 0.28;
  });
}

function pad(t0, freqs, dur, amp = 0.045) {
  add(t0, dur, (t) => {
    const env = Math.min(1, t / 0.35) * Math.min(1, (dur - t) / 0.4);
    let v = 0;
    for (const f of freqs) {
      v += Math.sin(2 * Math.PI * f * t) + 0.6 * Math.sin(2 * Math.PI * f * 1.003 * t);
      v += 0.15 * Math.sin(4 * Math.PI * f * t);
    }
    return v * env * amp;
  });
}

function pluck(t0, f) {
  add(t0, 0.5, (t) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 0.07, 0.7, 1.3);
}

// Am, F, C, G
const chords = [
  { pad: [220.0, 261.63, 329.63], root: 110.0, arp: [440, 523.25, 659.25, 523.25] },
  { pad: [174.61, 220.0, 261.63], root: 87.31, arp: [349.23, 440, 523.25, 440] },
  { pad: [261.63, 329.63, 392.0], root: 130.81, arp: [523.25, 659.25, 783.99, 659.25] },
  { pad: [196.0, 246.94, 293.66], root: 98.0, arp: [392, 493.88, 587.33, 493.88] },
];

for (let bar = 0; bar < totalBars; bar++) {
  const t = bar * BAR;
  const c = chords[bar % chords.length];
  const intro = bar < introBars;
  const outro = bar >= totalBars - outroBars;
  pad(t, c.pad, BAR + 0.3);
  if (!intro) bass(t, c.root, BAR * 0.5), bass(t + BAR * 0.5, c.root, BAR * 0.5);
  for (let b = 0; b < 4; b++) {
    const tb = t + b * BEAT;
    if (!intro && !outro) {
      if (b === 0 || b === 2) kick(tb);
      if (b === 1 || b === 3) clap(tb);
      if (b === 3) kick(tb + BEAT / 2);
    }
    if (bar >= 1 && !outro) {
      hat(tb + BEAT / 2, 0.06);
      if (!intro) hat(tb, 0.035, 1.2);
    }
    if (!intro || bar === introBars - 1) pluck(tb + (b % 2) * (BEAT / 2), c.arp[b]);
  }
}
// The last bar rings out on the tonic.
pad(totalBars * BAR - BAR, chords[0].pad, BAR, 0.05);

// Fade in / out, normalize, write 16-bit stereo WAV.
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const g = Math.min(1, t / 0.6) * Math.min(1, (seconds - t) / 1.5);
  L[i] *= g;
  R[i] *= g;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = 0.8 / (peak || 1);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * gain)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * gain)) * 32767), 46 + i * 4);
}
fs.writeFileSync(out, buf);
console.log(`${out}: ${seconds}s, ${totalBars} bars at ${BPM} BPM`);

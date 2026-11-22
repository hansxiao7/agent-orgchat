#!/usr/bin/env node
// Cut a raw VHS/puppeteer recording into a short captioned GIF ("beats").
// Needs ffmpeg and Google Chrome (captions are rendered as images, since many
// ffmpeg builds lack drawtext). No npm dependencies.
//
//   node docs/demo/edit.mjs <spec.json>
//
// spec: { input, output (gif), video? (mp4), width, captionHeight, beats: [{ from, to, speed, hold, caption }] }

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = path.dirname(path.resolve(process.argv[2]));
const rel = (p) => path.resolve(base, p);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgchat-edit-'));

const probe = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
const [W, H] = probe(rel(spec.input));
const CH = spec.captionHeight ?? 64;
const total = spec.beats.length;

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
spec.beats.forEach((b, i) => {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${CH}px;background:#16181d;overflow:hidden}
    body{display:flex;align-items:center;gap:16px;padding:0 24px;box-sizing:border-box;border-top:1px solid #2a2d35;
      font:500 22px/1 -apple-system,"SF Pro Text","Helvetica Neue",sans-serif;color:#e8e8e3}
    .n{font-weight:700;color:#16181d;background:#7fd1b2;border-radius:999px;min-width:30px;height:30px;padding:0 8px;box-sizing:border-box;display:grid;place-items:center;font-size:17px}
    .of{color:#7d808a;font-size:16px;margin-left:auto}
  </style><body><span class="n">${spec.prefix || ''}${i + 1}</span><span>${esc(b.caption)}</span><span class="of">${esc(spec.tag || 'orgchat')}</span></body>`;
  fs.writeFileSync(path.join(tmp, `c${i}.html`), html);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${CH}`, `--screenshot=${path.join(tmp, `c${i}.png`)}`, `file://${path.join(tmp, `c${i}.html`)}`], { stdio: 'ignore' });
});

const fps = spec.fps || 12;
const inputs = ['-i', rel(spec.input), ...spec.beats.flatMap((_, i) => ['-i', path.join(tmp, `c${i}.png`)])];
const parts = spec.beats.map((b, i) => {
  const speed = b.speed || 1;
  const hold = b.hold ? `,tpad=stop_mode=clone:stop_duration=${b.hold}` : '';
  return `[0:v]trim=start=${b.from}:end=${b.to},setpts=(PTS-STARTPTS)/${speed},fps=${fps}${hold},pad=${W}:${H + CH}:0:0:color=#16181d[v${i}];` +
    `[v${i}][${i + 1}:v]overlay=0:${H}[s${i}]`;
});
const concat = spec.beats.map((_, i) => `[s${i}]`).join('') + `concat=n=${total}:v=1:a=0[cat]`;
const width = spec.width || 1200;
const graph = `${parts.join(';')};${concat};[cat]scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-loop', '0', rel(spec.output)], { stdio: 'inherit' });

if (spec.video) {
  const vgraph = `${parts.join(';')};${concat};[cat]scale=${spec.videoWidth || W}:-2:flags=lanczos,format=yuv420p[out]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', vgraph, '-map', '[out]', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', rel(spec.video)], { stdio: 'inherit' });
  console.log(`${spec.video}: ${(fs.statSync(rel(spec.video)).size / 1024 / 1024).toFixed(2)} MB`);
}
const size = fs.statSync(rel(spec.output)).size;
const dur = spec.beats.reduce((s, b) => s + (b.to - b.from) / (b.speed || 1) + (b.hold || 0), 0);
console.log(`${spec.output}: ${(size / 1024 / 1024).toFixed(2)} MB, ~${dur.toFixed(1)} s, ${total} beats`);
fs.rmSync(tmp, { recursive: true, force: true });

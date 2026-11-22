#!/usr/bin/env node
// Renders the launch video frame by frame: serves index.html, calls
// window.renderAt(t) for every frame, screenshots it, synthesizes the
// soundtrack from the scene cues and muxes everything with ffmpeg.
//
//   PUPPETEER_CORE=/path/to/puppeteer-core node docs/demo/video/render.mjs
//   ... render.mjs --stills 3,9,15     # just a few frames, for checking
//
// Inputs: docs/demo/out/beat1-ask.mp4 (VHS capture) and docs/demo/out/beat2-panel.mp4.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'out');
const srcDir = path.join(outDir, 'video-src');
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const stillsArg = process.argv.indexOf('--stills');
const stills = stillsArg > 0 ? process.argv[stillsArg + 1].split(',').map(Number) : null;

// 1. Recording frames as JPEGs, addressable by index.
function extract(name, input, fps, seconds) {
  const dir = path.join(srcDir, name);
  if (fs.existsSync(path.join(dir, '00001.jpg'))) return;
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(outDir, input), '-t', String(seconds), '-vf', `fps=${fps}`, '-q:v', '2', path.join(dir, '%05d.jpg')]);
}
extract('beat1', 'beat1-ask.mp4', 25, 33);
extract('panel', 'beat2-panel.mp4', 10, 9);

// 2. Static server.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = url.startsWith('/src/') ? path.join(srcDir, url.slice(5)) : path.join(here, url === '/' ? 'index.html' : url);
  if (!file.startsWith(here) && !file.startsWith(srcDir)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 3. Frames.
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`${base}/index.html`);
await page.waitForFunction(() => window.VIDEO);
const { DURATION, FPS, CUES } = await page.evaluate(() => window.VIDEO);

if (stills) {
  for (const t of stills) {
    await page.evaluate((x) => window.renderAt(x), t);
    const f = path.join(outDir, `still-${t}.png`);
    await page.screenshot({ path: f });
    console.log(f);
  }
  await browser.close();
  server.close();
  process.exit(0);
}

const frames = path.join(outDir, 'video-frames');
fs.rmSync(frames, { recursive: true, force: true });
fs.mkdirSync(frames, { recursive: true });
const total = Math.round(DURATION * FPS);
const started = Date.now();
for (let i = 0; i < total; i++) {
  await page.evaluate((x) => window.renderAt(x), i / FPS);
  await page.screenshot({ path: path.join(frames, `${String(i + 1).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 93 });
  if (i % 150 === 0) console.log(`frame ${i}/${total} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}
await browser.close();
server.close();

// 4. Soundtrack + mux.
const cuesFile = path.join(outDir, 'cues.json');
fs.writeFileSync(cuesFile, JSON.stringify(CUES));
const wav = path.join(outDir, 'soundtrack.wav');
execFileSync('node', [path.join(here, 'soundtrack.mjs'), cuesFile, wav, String(DURATION)], { stdio: 'inherit' });
const mp4 = path.join(outDir, 'orgchat-launch.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(frames, '%05d.jpg'), '-i', wav,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', mp4], { stdio: 'inherit' });
console.log(`${mp4}: ${DURATION}s, ${(fs.statSync(mp4).size / 1024 / 1024).toFixed(1)} MB`);

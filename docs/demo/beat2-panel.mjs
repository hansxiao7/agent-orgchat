#!/usr/bin/env node
// Beat 2 recording: the admin panel while encrypted messages flow.
// Real relay, real orgchat clients (scripted, labelled as different agents: demo data).
// Needs Google Chrome and puppeteer-core (set PUPPETEER_CORE to its path, or `npm i -g puppeteer-core`).
//
//   node docs/demo/beat2-panel.mjs     -> docs/demo/out/beat2-panel.mp4

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, configFromEnv } from '../../relay/src/relay.mjs';
import { RelayClient } from '../../client/lib/relay-client.mjs';
import { loadIdentity, KnownKeys } from '../../client/lib/e2e.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgchat-beat2-'));
const frames = path.join(tmp, 'frames');
fs.mkdirSync(frames);

const relay = createRelay({ ...configFromEnv({ ORGCHAT_TOKENS: 'acme=t', ORGCHAT_PANEL_TOKENS: 'acme=panel', ORGCHAT_DB: ':memory:' }), log: () => {} });
const port = await relay.listen(0, '127.0.0.1');
const url = `ws://127.0.0.1:${port}`;

async function peer(user, name, agent, host, cwd) {
  const c = new RelayClient(
    { relayUrl: url, token: 't', user, name, host, cwd, e2e: true, configFile: '-' },
    { agent, identity: loadIdentity(path.join(tmp, `${name}.json`)), knownKeys: new KnownKeys(path.join(tmp, `${name}-kk.json`)), onMessage: () => {} },
  );
  c.connect();
  await c.ready();
  return c;
}

const alice = await peer('alice@acme.com', 'alice-api', 'claude-code', 'alice-mbp', '~/src/api');
const bob = await peer('bob@acme.com', 'bob-web', 'codex', 'bob-linux', '~/src/web');
const carol = await peer('carol@acme.com', 'Carol (lark)', 'human-lark', 'lark', '');
const dan = await peer('dan@acme.com', 'dan-ios', 'cursor', 'dan-mbp', '~/src/ios');
const erin = await peer('erin@acme.com', 'erin-infra', 'gemini-cli', 'erin-pc', '~/src/infra');

const script = [
  [1.2, () => alice.sendMessage('bob-web', 'Which port does the API dev server need?', { thread: 't_9f2a' })],
  [2.2, () => bob.sendMessage('alice-api', '8080, and export REDIS_URL first', { thread: 't_9f2a' })],
  [3.4, () => carol.sendMessage('dan-ios', 'Is the iOS build green?', { thread: 't_41c0' })],
  [4.4, () => dan.sendMessage('user:carol@acme.com', 'Yes, build 214 passed', { thread: 't_41c0' })],
  [5.6, () => erin.sendMessage('user:alice@acme.com', 'Migrating staging DB in 5 min, hold deploys', { thread: 't_d07e' })],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 940, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.goto(`http://127.0.0.1:${port}/panel?refresh=0.4`);
await page.type('#token', 'panel');
await page.click('button.primary');
await page.waitForSelector('#sessions tr');
await new Promise((r) => setTimeout(r, 600));

const FPS = 10;
const DURATION = 9;
const start = Date.now();
let n = 0;
const pending = [...script];
while (Date.now() - start < DURATION * 1000) {
  const t = (Date.now() - start) / 1000;
  while (pending.length && pending[0][0] <= t) pending.shift()[1]();
  await page.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
  const next = start + (n * 1000) / FPS;
  await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
}
await browser.close();
for (const c of [alice, bob, carol, dan, erin]) c.close();
await relay.close();

const out = path.join(here, 'out', 'beat2-panel.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });
const realFps = n / DURATION;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', realFps.toFixed(2), '-i', path.join(frames, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', out]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${out}: ${n} frames, ${realFps.toFixed(1)} fps`);

#!/usr/bin/env node
// Builds the end-to-end demo video: title -> beat 1 -> beat 2 -> outro, with
// section cards, cuts on bar lines of a synthesized 120 BPM soundtrack.
// Inputs are the per-beat MP4s written by edit.mjs. Needs ffmpeg + Google Chrome.
//
//   node docs/demo/compose.mjs   -> docs/demo/out/orgchat-e2e-demo.mp4 (+ docs/media/orgchat-e2e-demo.gif, silent)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (p) => path.join(here, 'out', p);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1600, H = 900, FPS = 30, BAR = 2; // 120 BPM, 4/4
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgchat-compose-'));

// 1. Per-beat clips with "1.x" / "2.x" step badges.
for (const [spec, prefix] of [['beat1-ask.json', '1.'], ['beat2-panel.json', '2.']]) {
  const s = JSON.parse(fs.readFileSync(path.join(here, spec), 'utf8'));
  const tmpSpec = path.join(here, `.compose-${spec}`);
  fs.writeFileSync(tmpSpec, JSON.stringify({ ...s, prefix, output: `out/compose-${spec.replace('.json', '.gif')}`, video: `out/compose-${spec.replace('.json', '.mp4')}` }));
  execFileSync('node', [path.join(here, 'edit.mjs'), tmpSpec], { stdio: 'inherit' });
  fs.rmSync(tmpSpec);
}

// 2. Cards.
const css = `html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#0f1115;color:#ecece6;
  font-family:-apple-system,"SF Pro Display","Helvetica Neue",sans-serif}
  body{display:flex;flex-direction:column;justify-content:center;padding:0 140px;box-sizing:border-box}
  .k{color:#7fd1b2;font:600 26px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.06em;margin-bottom:28px}
  h1{font-size:76px;line-height:1.05;margin:0 0 28px;font-weight:700;letter-spacing:-.02em}
  p{font-size:30px;line-height:1.45;margin:0;color:#a4a7ae;max-width:1200px}
  .chips{display:flex;flex-wrap:wrap;gap:12px;margin-top:40px}
  .chip{font-size:24px;padding:8px 18px;border-radius:999px;background:#1c2028;color:#d6d8dc;border:1px solid #2b3039}
  .chip.h{background:#16352c;color:#9fe3c8;border-color:#245544}
  .url{font:600 40px/1.2 ui-monospace,"SF Mono",Menlo,monospace;color:#ecece6;margin-top:8px}`;
const cards = {
  title: `<div class="k">orgchat</div><h1>Let everyone's AI agents<br>talk to each other.</h1>
    <p>Across machines, across people, across vendors. Inside one organization.</p>
    <div class="chips"><span class="chip">Claude Code</span><span class="chip">Codex</span><span class="chip">Cursor</span><span class="chip">Gemini CLI</span><span class="chip">Cline · DeepSeek</span><span class="chip">Lark / Slack</span></div>`,
  s1: `<div class="k">01</div><h1>Ask a teammate's agent</h1><p>Alice's Claude Code asks Bob. Bob answers from his terminal.</p>`,
  s2: `<div class="k">02</div><h1>The relay can't read it</h1><p>Everything is end-to-end encrypted. Admins see who talks to whom, never what.</p>`,
  outro: `<div class="k">open source · MIT</div><h1>orgchat</h1><div class="url">github.com/hansxiao7/agent-orgchat</div>
    <div class="chips"><span class="chip h">MCP server</span><span class="chip h">CLI</span><span class="chip h">end-to-end encrypted</span><span class="chip h">self-hosted relay</span><span class="chip h">Lark / Slack bridge</span></div>`,
};
for (const [name, body] of Object.entries(cards)) {
  const html = path.join(tmp, `${name}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css}</style><body>${body}</body>`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, `--screenshot=${path.join(tmp, `${name}.png`)}`, `file://${html}`], { stdio: 'ignore' });
}

// 3. Timeline, in bars (2 s each).
const timeline = [
  { kind: 'image', src: path.join(tmp, 'title.png'), bars: 2 },
  { kind: 'image', src: path.join(tmp, 's1.png'), bars: 1 },
  { kind: 'video', src: out('compose-beat1-ask.mp4'), bars: 7 },
  { kind: 'image', src: path.join(tmp, 's2.png'), bars: 1 },
  { kind: 'video', src: out('compose-beat2-panel.mp4'), bars: 5 },
  { kind: 'image', src: path.join(tmp, 'outro.png'), bars: 3 },
];
const total = timeline.reduce((s, x) => s + x.bars * BAR, 0);

// 4. Soundtrack.
const wav = path.join(tmp, 'music.wav');
execFileSync('node', [path.join(here, 'music.mjs'), wav, String(total), '2', '2'], { stdio: 'inherit' });

// 5. Compose.
const inputs = [];
const filters = [];
timeline.forEach((seg, i) => {
  const d = seg.bars * BAR;
  if (seg.kind === 'image') inputs.push('-loop', '1', '-t', String(d), '-i', seg.src);
  else inputs.push('-i', seg.src);
  // Fit inside the frame with a margin, on the dark background; freeze the last frame to fill the bars.
  filters.push(
    `[${i}:v]scale=w='min(${W - 80},iw)':h='min(${H - 60},ih)':force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=#0f1115,fps=${FPS},setsar=1,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`,
  );
});
const n = timeline.length;
filters.push(`${timeline.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0,fade=t=in:st=0:d=0.5,fade=t=out:st=${total - 0.8}:d=0.8[v]`);
filters.push(`[${n}:a]atrim=duration=${total}[a]`);
const mp4 = out('orgchat-e2e-demo.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-i', wav, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', mp4], { stdio: 'inherit' });

// Silent GIF of the whole thing for the README.
const gif = path.join(here, '..', 'media', 'orgchat-e2e-demo.gif');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-filter_complex',
  'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', gif], { stdio: 'inherit' });

for (const f of ['compose-beat1-ask.gif', 'compose-beat2-panel.gif']) fs.rmSync(out(f), { force: true });
fs.rmSync(tmp, { recursive: true, force: true });
const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2);
console.log(`${mp4}: ${total}s, ${mb(mp4)} MB\n${gif}: ${mb(gif)} MB`);

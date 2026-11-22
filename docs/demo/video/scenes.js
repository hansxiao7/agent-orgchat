// orgchat launch video. Every frame is a pure function of t (seconds), so the
// renderer can step through time deterministically: window.renderAt(t).
// Timeline is on a 120 BPM grid (1 bar = 2 s); cues are exported for the soundtrack.

export const DURATION = 46;
export const FPS = 30;

// ---------------------------------------------------------------- helpers
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const E = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  expo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};
const p = (t, start, dur) => clamp((t - start) / dur);
function spring(t, freq = 1.7, damp = 0.5) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq, wd = w * Math.sqrt(1 - damp * damp);
  return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + ((damp * w) / wd) * Math.sin(wd * t));
}
// piecewise keyframes: [[t, value], ...] with easing between
function kf(t, frames, ease = E.inOut) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1] = frames[i];
    const [t0, v0] = frames[i - 1];
    if (t <= t1) {
      const k = ease(clamp((t - t0) / (t1 - t0 || 1)));
      return Array.isArray(v0) ? v0.map((x, j) => lerp(x, v1[j], k)) : lerp(v0, v1, k);
    }
  }
  return frames[frames.length - 1][1];
}
const hash = (n) => { let x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
const CIPHER = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789+/=';
function scramble(text, amount, seed) {
  // amount 0 = plain, 1 = fully scrambled; scrambles left to right
  return [...text].map((c, i) => {
    if (c === ' ') return amount > 0.5 ? CIPHER[Math.floor(hash(seed + i * 7.3) * CIPHER.length)] : ' ';
    const local = clamp(amount * 1.6 - (i / text.length) * 0.6);
    return local > 0.5 ? CIPHER[Math.floor(hash(seed + i * 3.1) * CIPHER.length)] : c;
  }).join('');
}

const $ = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
const root = document.getElementById('scenes');
function scene(id) { const el = $(`<div class="scene" id="${id}"></div>`); root.appendChild(el); return el; }
function add(parent, html, style = {}) { const el = $(html); Object.assign(el.style, style); parent.appendChild(el); return el; }
function words(el, text) {
  el.innerHTML = '';
  return text.split(/(\s+)/).filter((w) => w.length).map((w) => {
    const cls = w.startsWith('*') ? 'word hl' : w.startsWith('!') ? 'word bad' : 'word';
    const s = $(`<span class="${cls}">${w.replace(/^[*!]/, '')}</span>`);
    el.appendChild(s);
    return s;
  });
}
function revealWords(spans, t, start, stagger = 0.06, rise = 40) {
  spans.forEach((s, i) => {
    const k = E.out(p(t, start + i * stagger, 0.45));
    s.style.opacity = k;
    s.style.transform = `translateY(${(1 - k) * rise}px)`;
  });
}
function show(el, o, transform = '') { el.style.opacity = o; el.style.transform = transform; el.style.visibility = o > 0.001 ? 'visible' : 'hidden'; }

// headline that swaps between lines at given times (slide up + fade)
function swapHeadline(parent, lines, style) {
  const box = add(parent, `<div class="abs headline"></div>`, style);
  const items = lines.map(([at, text]) => {
    const line = add(box, `<div class="abs" style="left:0;top:0;white-space:nowrap"></div>`);
    return { at, spans: words(line, text), line };
  });
  return (t) => items.forEach((it, i) => {
    const next = items[i + 1];
    const out = next ? E.in(p(t, next.at - 0.22, 0.2)) : 0;
    it.line.style.opacity = t < it.at ? 0 : 1 - out;
    it.line.style.transform = `translateY(${-out * 30}px)`;
    revealWords(it.spans, t, it.at, 0.045, 36);
  });
}

// ---------------------------------------------------------------- cues for the soundtrack
export const CUES = [];
const cue = (t, type, extra = {}) => CUES.push({ t, type, ...extra });

// ---------------------------------------------------------------- background
const glow1 = document.getElementById('glow1');
const glow2 = document.getElementById('glow2');
function renderBg(t) {
  glow1.style.transform = `translate(${-100 + Math.sin(t * 0.25) * 120}px, ${-80 + Math.cos(t * 0.2) * 80}px)`;
  glow2.style.transform = `translate(${1300 + Math.cos(t * 0.22) * 140}px, ${600 + Math.sin(t * 0.3) * 90}px)`;
}

// ================================================================ S1 hook 0–6
const s1 = scene('s1');
const s1Lines = [
  add(s1, `<div class="abs headline" style="left:0;right:0;top:120px;text-align:center"></div>`),
  add(s1, `<div class="abs headline" style="left:0;right:0;top:120px;text-align:center"></div>`),
  add(s1, `<div class="abs headline" style="left:0;right:0;top:120px;text-align:center;font-size:92px"></div>`),
];
const s1Words = [
  words(s1Lines[0], 'Your team runs a lot of AI agents.'),
  words(s1Lines[1], "They !can't talk to each other."),
  words(s1Lines[2], 'Now *they *can.'),
];
const AGENTS = [
  ['Claude Code', '#f59e8b'], ['Codex', '#e5e7eb'], ['Cursor', '#93c5fd'],
  ['Gemini CLI', '#a5b4fc'], ['Cline · DeepSeek', '#6ee7b7'], ['Windsurf', '#67e8f9'],
];
const CX = 960, CY = 640;
const chipPos = AGENTS.map((_, i) => {
  const a = -Math.PI / 2 + (i / AGENTS.length) * Math.PI * 2 + Math.PI / AGENTS.length;
  return [CX + Math.cos(a) * 560, CY + Math.sin(a) * 250];
});
const svgNS = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(svgNS, 'svg');
svg.setAttribute('width', 1920); svg.setAttribute('height', 1080);
svg.style.position = 'absolute'; svg.style.inset = 0;
s1.appendChild(svg);
const links = chipPos.map(([x, y]) => {
  const l = document.createElementNS(svgNS, 'line');
  l.setAttribute('x1', CX); l.setAttribute('y1', CY); l.setAttribute('x2', x); l.setAttribute('y2', y);
  l.setAttribute('stroke', '#6ee7b7'); l.setAttribute('stroke-width', 3); l.setAttribute('stroke-linecap', 'round');
  const len = Math.hypot(x - CX, y - CY);
  l.setAttribute('stroke-dasharray', len); l.dataset.len = len;
  svg.appendChild(l);
  return l;
});
const broken = chipPos.map(([x, y], i) => {
  const [x2, y2] = chipPos[(i + 1) % chipPos.length];
  const l = document.createElementNS(svgNS, 'line');
  l.setAttribute('x1', x); l.setAttribute('y1', y); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
  l.setAttribute('stroke', '#3a4150'); l.setAttribute('stroke-width', 2.5); l.setAttribute('stroke-dasharray', '10 12');
  svg.appendChild(l);
  const m = add(s1, `<div class="abs" style="font:800 40px/1 -apple-system;color:#fb7185;transform:translate(-50%,-50%)">×</div>`, { left: `${(x + x2) / 2}px`, top: `${(y + y2) / 2}px` });
  return { l, m };
});
const chips = AGENTS.map(([name, color], i) => add(s1, `<div class="chip"><span class="dot" style="background:${color}"></span>${name}</div>`, { left: `${chipPos[i][0]}px`, top: `${chipPos[i][1]}px` }));
const core = add(s1, `<div id="core">orgchat</div>`, { left: `${CX}px`, top: `${CY}px` });
const packets = chipPos.map(() => add(s1, `<div class="abs" style="width:14px;height:14px;border-radius:50%;background:#d1fae5;box-shadow:0 0 18px #6ee7b7,0 0 4px #fff;transform:translate(-50%,-50%)"></div>`));
AGENTS.forEach((_, i) => cue(0.5 + i * 0.5, 'pop', { pitch: i }));
cue(3.0, 'glitch'); cue(4.0, 'impact'); cue(2.0, 'riser', { dur: 2 });

function renderS1(t) {
  const out = E.in(p(t, 5.9, 0.4));
  show(s1, t < 6.3 ? 1 - out : 0, `scale(${1 + out * 0.35})`);
  if (t >= 6.3) return;
  s1Lines[0].style.opacity = t < 2.95 ? 1 : 1 - p(t, 2.95, 0.15);
  s1Lines[1].style.opacity = t < 3 ? 0 : t < 3.95 ? 1 : 1 - p(t, 3.95, 0.12);
  s1Lines[2].style.opacity = t < 4 ? 0 : 1;
  revealWords(s1Words[0], t, 0.1);
  revealWords(s1Words[1], t, 3.0, 0.04);
  revealWords(s1Words[2], t, 4.0, 0.12, 60);
  // chips pop on the beat; shake when broken
  chips.forEach((c, i) => {
    const s = spring(t - (0.5 + i * 0.5), 2.2, 0.45);
    const shake = t > 3 && t < 4 ? Math.sin(t * 70 + i) * 4 * (1 - p(t, 3, 1)) : 0;
    c.style.opacity = clamp(s * 3);
    c.style.transform = `translate(calc(-50% + ${shake}px), -50%) scale(${s})`;
  });
  // broken links between neighbours
  broken.forEach(({ l, m }, i) => {
    const o = t < 3 ? 0 : t < 4 ? E.out(p(t, 3 + i * 0.03, 0.2)) : 1 - p(t, 4, 0.2);
    l.style.opacity = o * 0.9;
    m.style.opacity = o;
    m.style.transform = `translate(-50%,-50%) scale(${0.6 + 0.4 * spring(t - 3 - i * 0.03, 3, 0.4)})`;
  });
  // the core and its links
  const cs = spring(t - 4.0, 1.8, 0.42);
  core.style.opacity = clamp(cs * 3);
  core.style.transform = `translate(-50%,-50%) scale(${cs})`;
  links.forEach((l, i) => {
    const k = E.out(p(t, 4.05 + i * 0.04, 0.5));
    l.setAttribute('stroke-dashoffset', (1 - k) * Number(l.dataset.len));
    l.style.opacity = t < 4 ? 0 : 0.85;
  });
  packets.forEach((d, i) => {
    if (t < 4.6) return void (d.style.opacity = 0);
    const ph = ((t - 4.6) * 0.9 + i * 0.37) % 1;
    const [x, y] = chipPos[i];
    const toCore = ph < 0.5;
    const k = E.inOut(toCore ? ph * 2 : (ph - 0.5) * 2);
    const [tx, ty] = toCore ? [lerp(x, CX, k), lerp(y, CY, k)] : (() => { const [x2, y2] = chipPos[(i + 3) % chipPos.length]; return [lerp(CX, x2, k), lerp(CY, y2, k)]; })();
    d.style.opacity = 1;
    d.style.left = `${tx}px`; d.style.top = `${ty}px`;
  });
}

// ================================================================ S2 title 6–8
const s2 = scene('s2');
const LOGO = `<svg width="150" height="150" viewBox="0 0 120 120"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6ee7b7"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>
  <rect x="6" y="14" width="66" height="50" rx="16" fill="none" stroke="url(#lg)" stroke-width="8"/><path d="M22 64 L18 80 L38 64" fill="url(#lg)"/>
  <rect x="48" y="50" width="66" height="50" rx="16" fill="url(#lg)"/><path d="M98 100 L102 114 L84 100" fill="url(#lg)"/>
  <circle cx="68" cy="75" r="5" fill="#07090d"/><circle cx="82" cy="75" r="5" fill="#07090d"/><circle cx="96" cy="75" r="5" fill="#07090d"/></svg>`;
const wm = add(s2, `<div class="wordmark" style="left:960px;top:470px;font-size:200px">${LOGO}<span class="txt">orgchat</span></div>`);
const tagline = add(s2, `<div class="abs" style="left:0;right:0;top:640px;text-align:center;font-size:44px;font-weight:600;color:#cfd3da;letter-spacing:-.01em"></div>`);
const taglineWords = words(tagline, 'Messaging for every AI agent in your org.');
const tagline2 = add(s2, `<div class="abs mono" style="left:0;right:0;top:720px;text-align:center;font-size:26px;color:#8b909b;letter-spacing:.06em">END-TO-END ENCRYPTED · OPEN SOURCE · SELF-HOSTED</div>`);
cue(5.85, 'whoosh'); cue(6.0, 'boom');

function renderS2(t) {
  if (t < 5.9 || t > 8.3) return show(s2, 0);
  const out = E.inOut(p(t, 7.8, 0.35));
  show(s2, 1 - out, `translateY(${-out * 60}px)`);
  const s = spring(t - 6.0, 1.4, 0.5);
  wm.style.opacity = clamp(s * 2);
  wm.style.transform = `translate(-50%,-50%) scale(${0.7 + 0.3 * s})`;
  revealWords(taglineWords, t, 6.35, 0.05);
  tagline2.style.opacity = E.out(p(t, 6.9, 0.4));
}

// ================================================================ windowed recordings (shared)
function makeWindow(parent, { x, y, w, h, title, url, srcW, srcH }) {
  const win = add(parent, `<div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>${url ? `<div class="url">${url}</div>` : `<div class="t">${title}</div>`}</div><div class="body"><img></div></div>`,
    { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h + 44}px` });
  const img = win.querySelector('img');
  img.width = srcW; img.height = srcH;
  const base = w / srcW;
  // camera: zoom z around focus point (fx, fy) in source pixels, clamped to the frame
  const cam = (z, fx, fy) => {
    const S = base * z;
    const tx = clamp(w / 2 - fx * S, w - srcW * S, 0);
    const ty = clamp(h / 2 - fy * S, h - srcH * S, 0);
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${S})`;
    return { S, tx, ty };
  };
  const ring = (el, view, [x1, y1, x2, y2], o, pad = 8) => {
    Object.assign(el.style, {
      left: `${x + view.tx + x1 * view.S - pad}px`, top: `${y + 44 + view.ty + y1 * view.S - pad}px`,
      width: `${(x2 - x1) * view.S + pad * 2}px`, height: `${(y2 - y1) * view.S + pad * 2}px`, opacity: o,
    });
  };
  return { win, img, cam, ring };
}
async function setFrame(img, src) {
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.src = src;
  await img.decode().catch(() => {});
}

// ================================================================ S3 ask a teammate's agent 8–22
const s3 = scene('s3');
add(s3, `<div class="abs eyebrow" style="left:210px;top:96px">01 · Ask a teammate's agent</div>`);
const s3Head = swapHeadline(s3, [
  [0.15, "Alice's *Claude *Code asks Bob."],
  [4.3, 'Bob gets the question. *Encrypted.'],
  [6.6, 'Bob answers from his terminal.'],
  [8.9, 'Alice has the answer. *No *copy-paste.'],
], { left: '210px', top: '138px', width: '1500px', height: '80px' });
const W1 = makeWindow(s3, {
  x: 210, y: 262, w: 1500, h: 750, srcW: 1440, srcH: 720,
  title: `<span class="pill">alice-api · Claude Code</span><span class="pill">bob-web · terminal</span>`,
});
const s3Rings = [0, 1, 2, 3].map(() => add(s3, `<div class="ring"></div>`));
const s3Call = add(s3, `<div class="callout">🔒 end-to-end encrypted</div>`);
// scene-local time -> recording time (raw VHS capture, 25 fps)
const b1Src = (u) => (u < 4.3 ? u : u < 6.58 ? 4.3 + (u - 4.3) * 2.5 : u < 8.8 ? 27.6 + (u - 6.58) : Math.min(29.8 + (u - 8.8), 32));
cue(7.85, 'whoosh'); cue(8 + 6.1, 'ding'); cue(8 + 8.2, 'tick'); cue(8 + 10.05, 'ding');

async function renderS3(t) {
  const u = t - 8;
  if (u < -0.2 || u > 14.2) return show(s3, 0);
  const inK = E.out(p(u, -0.1, 0.6)), outK = E.in(p(u, 13.6, 0.4));
  show(s3, inK * (1 - outK));
  W1.win.style.transform = `translateY(${(1 - inK) * 80}px) scale(${1 - outK * 0.04})`;
  s3Head(u);
  await setFrame(W1.img, `/src/beat1/${String(Math.round(b1Src(u) * 25) + 1).padStart(5, '0')}.jpg`);
  const [z, fx, fy] = kf(u, [
    [0, [1, 720, 360]], [0.5, [1, 720, 360]], [1.3, [1.3, 430, 560]], [3.8, [1.3, 430, 560]],
    [4.5, [1, 720, 360]], [5.5, [1.75, 1130, 95]], [8.6, [1.75, 1130, 110]],
    [9.3, [1.05, 720, 360]], [10.0, [1.6, 420, 230]], [14, [1.6, 420, 230]],
  ]);
  const v = W1.cam(z, fx, fy);
  W1.ring(s3Rings[3], v, [14, 640, 832, 672], u > 0.9 && u < 4.2 ? E.out(p(u, 0.9, 0.3)) * (1 - p(u, 3.9, 0.3)) : 0);
  W1.ring(s3Rings[0], v, [842, 56, 1425, 112], (u > 6.1 && u < 8.0 ? E.out(p(u, 6.1, 0.25)) : 0) * (1 - p(u, 7.7, 0.3)));
  W1.ring(s3Rings[1], v, [842, 112, 1200, 150], u > 8.15 ? E.out(p(u, 8.15, 0.2)) * (1 - p(u, 8.7, 0.25)) : 0);
  W1.ring(s3Rings[2], v, [14, 220, 790, 262], u > 10.05 ? E.out(p(u, 10.05, 0.3)) * (1 - p(u, 13.4, 0.3)) : 0);
  const co = u > 6.25 && u < 8 ? spring(u - 6.25, 2.2, 0.5) * (1 - p(u, 7.7, 0.3)) : 0;
  Object.assign(s3Call.style, { left: '1080px', top: '545px', opacity: clamp(co * 2), transform: `scale(${0.6 + 0.4 * co})` });
}

// ================================================================ S4 end-to-end encryption 22–28
const s4 = scene('s4');
add(s4, `<div class="abs eyebrow" style="left:0;right:0;top:120px;text-align:center">02 · End-to-end encrypted</div>`);
const s4HeadEl = add(s4, `<div class="abs headline" style="left:0;right:0;top:166px;text-align:center"></div>`);
const s4Words = words(s4HeadEl, 'The relay only ever sees *ciphertext.');
const NY = 640;
const nodes = [
  add(s4, `<div class="node"><div class="n1">alice-api</div><div class="n2">Claude Code · 🔑 own key</div></div>`, { left: '330px', top: `${NY}px` }),
  add(s4, `<div class="node relay"><div class="srv"><b></b><b></b><b></b></div><div class="n1">relay</div><div class="n2">can't decrypt</div></div>`, { left: '960px', top: `${NY}px` }),
  add(s4, `<div class="node"><div class="n1">bob-web</div><div class="n2">terminal · 🔑 own key</div></div>`, { left: '1590px', top: `${NY}px` }),
];
const dashes = [add(s4, `<div class="dash"></div>`, { left: '530px', top: `${NY}px`, width: '265px' }), add(s4, `<div class="dash"></div>`, { left: '1125px', top: `${NY}px`, width: '265px' })];
const bub = add(s4, `<div class="bubble plain"></div>`);
const bub2 = add(s4, `<div class="bubble plain"></div>`);
const stored = add(s4, `<div class="stored"></div>`, { left: '960px', top: `${NY + 140}px` });
add(s4, `<div class="foot">X25519 · AES-256-GCM · keys never leave the device</div>`, { top: '930px' });
const Q = 'Which port does the API need?';
const A = '8080, and export REDIS_URL';
cue(21.85, 'whoosh'); cue(23.0, 'scramble'); cue(23.5, 'swoosh'); cue(24.6, 'swoosh'); cue(25.4, 'unscramble'); cue(26.3, 'scramble'); cue(27.2, 'unscramble');

function renderS4(t) {
  const u = t - 22;
  if (u < -0.2 || u > 6.2) return show(s4, 0);
  const inK = E.out(p(u, -0.1, 0.5)), outK = E.in(p(u, 5.75, 0.3));
  show(s4, inK * (1 - outK), `scale(${1 + outK * 0.05})`);
  revealWords(s4Words, u, 0.1, 0.05);
  nodes.forEach((n, i) => {
    const s = spring(u - 0.15 - i * 0.12, 2, 0.5);
    n.style.opacity = clamp(s * 2);
    n.style.transform = `translate(-50%,-50%) scale(${0.85 + 0.15 * s})`;
  });
  dashes.forEach((d) => (d.style.opacity = E.out(p(u, 0.5, 0.4))));
  // question: Alice -> relay -> Bob
  const fly = (u2) => (u2 < 1.5 ? 330 : u2 < 2.3 ? lerp(330, 960, E.inOut(p(u2, 1.5, 0.8))) : u2 < 2.6 ? 960 : lerp(960, 1590, E.inOut(p(u2, 2.6, 0.8))));
  const scr = u < 1.0 ? 0 : u < 3.4 ? E.out(p(u, 1.0, 0.45)) : 1 - E.out(p(u, 3.4, 0.5));
  const qs = spring(u - 0.5, 2.2, 0.5);
  const qOut = p(u, 4.3, 0.3);
  bub.textContent = (scr > 0.02 ? '🔒 ' : '') + scramble(Q, scr, Math.floor(u * 14));
  bub.className = `bubble ${scr > 0.5 ? 'cipher' : 'plain'}`;
  const keep = (x, el) => clamp(x, el.offsetWidth / 2 + 60, 1920 - el.offsetWidth / 2 - 60);
  Object.assign(bub.style, { left: `${keep(fly(u), bub)}px`, top: `${NY - 150}px`, opacity: clamp(qs * 2) * (1 - qOut), transform: `translate(-50%,-50%) scale(${0.7 + 0.3 * qs})` });
  stored.innerHTML = `stored: <b>${scramble('9f2aQx81LmZt', 1, 42)}…</b><br><span style="color:#8b909b">ciphertext only, deleted after delivery</span>`;
  stored.style.opacity = u > 2.2 ? E.out(p(u, 2.2, 0.3)) : 0;
  // reply: Bob -> relay -> Alice, quicker
  const r = u - 4.4;
  const rx = r < 0.3 ? 1590 : r < 0.8 ? lerp(1590, 960, E.inOut(p(r, 0.3, 0.5))) : r < 0.9 ? 960 : lerp(960, 330, E.inOut(p(r, 0.9, 0.5)));
  const rscr = r < 0 ? 0 : r < 1.4 ? E.out(p(r, 0.0, 0.3)) : 1 - E.out(p(r, 1.4, 0.3));
  const rs = spring(r, 2.2, 0.5);
  bub2.textContent = (rscr > 0.02 ? '🔒 ' : '') + scramble(A, rscr, Math.floor(u * 14) + 99);
  bub2.className = `bubble ${rscr > 0.5 ? 'cipher' : 'plain'}`;
  Object.assign(bub2.style, { left: `${keep(rx, bub2)}px`, top: `${NY + 150 - 300}px`, opacity: r < 0 ? 0 : clamp(rs * 2), transform: `translate(-50%,-50%) scale(${0.7 + 0.3 * rs})` });
}

// ================================================================ S5 admin panel 28–34
const s5 = scene('s5');
add(s5, `<div class="abs eyebrow" style="left:260px;top:96px">03 · Admin panel</div>`);
const s5Head = swapHeadline(s5, [[0.15, 'Admins see who talks to whom.'], [3.0, '*Never *what.']], { left: '260px', top: '138px', width: '1400px', height: '80px' });
const W2 = makeWindow(s5, { x: 260, y: 262, w: 1400, h: 760, srcW: 1280, srcH: 940, url: 'relay.acme.dev/panel' });
const s5Rings = [0, 1].map(() => add(s5, `<div class="ring"></div>`));
cue(27.85, 'whoosh');

async function renderS5(t) {
  const u = t - 28;
  if (u < -0.2 || u > 6.2) return show(s5, 0);
  const inK = E.out(p(u, -0.1, 0.6)), outK = E.in(p(u, 5.7, 0.35));
  show(s5, inK * (1 - outK));
  W2.win.style.transform = `translateY(${(1 - inK) * 80}px) scale(${1 - outK * 0.04})`;
  s5Head(u);
  const src = Math.min(0.8 + u * 1.45, 8.9);
  await setFrame(W2.img, `/src/panel/${String(Math.round(src * 10) + 1).padStart(5, '0')}.jpg`);
  const [z, fx, fy] = kf(u, [[0, [1, 640, 300]], [1.0, [1.25, 640, 200]], [2.2, [1, 640, 700]], [3.0, [1.6, 1085, 780]], [6, [1.65, 1085, 780]]]);
  const v = W2.cam(z, fx, fy);
  W2.ring(s5Rings[0], v, [530, 86, 749, 160], u > 0.9 && u < 2.4 ? E.out(p(u, 0.9, 0.25)) * (1 - p(u, 2.0, 0.3)) : 0);
  W2.ring(s5Rings[1], v, [954, 646, 1216, 928], u > 3.05 ? E.out(p(u, 3.05, 0.3)) : 0);
}

// ================================================================ S6 every agent, and people 34–40
const s6 = scene('s6');
add(s6, `<div class="abs eyebrow" style="left:160px;top:96px">04 · Every agent. And people too.</div>`);
const s6Head = swapHeadline(s6, [[0.15, 'One line in any agent\'s MCP config.'], [3.0, 'People join from *Lark or *Slack.']], { left: '160px', top: '138px', width: '1600px', height: '80px' });
const CODE = [
  ['p', '"orgchat": {'], ['k', '\n  "command"'], ['p', ': '], ['s', '"npx"'], ['p', ','],
  ['k', '\n  "args"'], ['p', ': ['], ['s', '"-y"'], ['p', ', '], ['s', '"orgchat-mcp"'], ['p', ']\n}'],
];
const CODE_LEN = CODE.reduce((s, [, x]) => s + x.length, 0);
const code = add(s6, `<div class="code"></div>`, { left: '160px', top: '290px', width: '820px' });
const AG = ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'Cline', 'Windsurf', 'opencode', 'Roo Code'];
const agentEls = AG.map((a, i) => add(s6, `<div class="agent">${a}</div>`, { left: `${160 + (i % 4) * 205}px`, top: `${640 + Math.floor(i / 4) * 72}px` }));
const chat = add(s6, `<div class="chat"><div class="hd"><span class="av"></span>orgchat bot<small>IM bridge · Lark / Slack</small></div></div>`, { left: '1060px', top: '290px', width: '700px', height: '520px' });
const msgs = [
  add(chat, `<div class="msg bot"><span class="meta">bob-codex · codex 🔒</span>Staging is migrated: 0042 ran at 10:02.</div>`, { top: '100px' }),
  add(chat, `<div class="msg me">Thanks! Deploying now 🚀</div>`, { top: '250px' }),
  add(chat, `<div class="msg bot" style="padding:12px 18px;font-size:21px;color:#9ca3af">✓ sent to bob-codex 🔒</div>`, { top: '350px' }),
];
cue(33.85, 'whoosh');
AG.forEach((_, i) => cue(35.9 + i * 0.25, 'pop', { pitch: i % 6, soft: true }));
[35.0, 36.4, 37.6].forEach((x) => cue(x, 'pop', { pitch: 4 }));
cue(34.4, 'typing', { dur: 1.3 });

function renderS6(t) {
  const u = t - 34;
  if (u < -0.2 || u > 6.2) return show(s6, 0);
  const inK = E.out(p(u, -0.1, 0.5)), outK = E.in(p(u, 5.7, 0.35));
  show(s6, inK * (1 - outK), `translateY(${(1 - inK) * 40}px)`);
  s6Head(u);
  const n = Math.floor(clamp((u - 0.4) / 1.3) * CODE_LEN);
  let left = n, html = '';
  for (const [cls, txt] of CODE) {
    if (left <= 0) break;
    html += `<span class="${cls}">${txt.slice(0, left).replace(/</g, '&lt;')}</span>`;
    left -= txt.length;
  }
  code.innerHTML = html + (Math.floor(u * 2.5) % 2 === 0 || n < CODE_LEN ? '<span class="cursor"></span>' : '');
  agentEls.forEach((el, i) => {
    const on = u > 1.9 + i * 0.25;
    el.className = `agent${on ? ' on' : ''}`;
    const s = on ? spring(u - 1.9 - i * 0.25, 3, 0.4) : 0;
    el.style.transform = `scale(${1 + 0.08 * Math.sin(Math.PI * clamp(s))})`;
  });
  const cs = spring(u - 0.3, 2, 0.5);
  chat.style.opacity = clamp(cs * 2);
  chat.style.transform = `translateY(${(1 - cs) * 40}px)`;
  [1.0, 2.4, 3.6].forEach((at, i) => {
    const s = spring(u - at, 2.4, 0.5);
    msgs[i].style.opacity = clamp(s * 2);
    msgs[i].style.transform = `translateY(${(1 - s) * 30}px) scale(${0.9 + 0.1 * s})`;
  });
}

// ================================================================ S7 call to action 40–46
const s7 = scene('s7');
const wm2 = add(s7, `<div class="wordmark" style="left:960px;top:330px;font-size:140px">${LOGO.replace('width="150" height="150"', 'width="110" height="110"')}<span class="txt">orgchat</span></div>`);
const term = add(s7, `<div class="term"></div>`, { left: '960px', top: '500px' });
const gh = add(s7, `<div class="abs mono" style="left:0;right:0;top:660px;text-align:center;font-size:34px;color:#cfd3da">github.com/hansxiao7/agent-orgchat</div>`);
const tags = add(s7, `<div class="tag"><span>Open source · MIT</span><span>Self-hosted relay</span><span>End-to-end encrypted</span><span>Any MCP agent</span></div>`, { left: '960px', top: '760px' });
const CMD = 'npx -y orgchat-mcp';
cue(39.85, 'whoosh'); cue(40.0, 'boom'); cue(40.6, 'typing', { dur: 0.9 }); cue(38.0, 'riser', { dur: 2 });

function renderS7(t) {
  const u = t - 40;
  if (u < -0.2) return show(s7, 0);
  show(s7, E.out(p(u, -0.1, 0.4)));
  const s = spring(u, 1.5, 0.5);
  wm2.style.opacity = clamp(s * 2);
  wm2.style.transform = `translate(-50%,-50%) scale(${0.75 + 0.25 * s})`;
  const n = Math.floor(clamp((u - 0.6) / 0.9) * CMD.length);
  const ts = spring(u - 0.4, 2, 0.5);
  term.innerHTML = `<span class="p">$ </span>${CMD.slice(0, n)}<span class="cursor" style="height:46px;vertical-align:-6px;opacity:${Math.floor(u * 2.5) % 2 === 0 || n < CMD.length ? 1 : 0}"></span>`;
  term.style.opacity = clamp(ts * 2);
  term.style.transform = `translateX(-50%) translateY(${(1 - ts) * 30}px)`;
  gh.style.opacity = E.out(p(u, 1.7, 0.4));
  gh.style.transform = `translateY(${(1 - E.out(p(u, 1.7, 0.4))) * 20}px)`;
  tags.style.opacity = E.out(p(u, 2.2, 0.4));
  tags.style.transform = `translateX(-50%) translateY(${(1 - E.out(p(u, 2.2, 0.4))) * 20}px)`;
}

// ---------------------------------------------------------------- frame
const fade = document.getElementById('fade');
window.renderAt = async (t) => {
  renderBg(t);
  renderS1(t);
  renderS2(t);
  await renderS3(t);
  renderS4(t);
  await renderS5(t);
  renderS6(t);
  renderS7(t);
  fade.style.opacity = Math.max(1 - p(t, 0, 0.4), p(t, DURATION - 0.9, 0.9));
};
window.VIDEO = { DURATION, FPS, CUES };
window.renderAt(0);

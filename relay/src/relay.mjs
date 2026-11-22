// orgchat relay: routes messages between AI agent sessions (any MCP-capable
// agent, the CLI, IM bridges, scripts) that belong to the same organization.
//
// - Messages are end-to-end encrypted by clients; the relay only sees envelopes.
// - State (sessions, offline queue, history metadata) is kept in SQLite.
// - Optional read-only web panel for org admins at /panel.
// Run a single instance per database.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { createOidcVerifier } from './oidc.mjs';
import { openStore, rowToWire } from './store.mjs';

const SID_RE = /^s_[a-f0-9]{6,32}$/;
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const PANEL_HTML = fs.readFileSync(new URL('./panel.html', import.meta.url), 'utf8');

function parsePairs(value) {
  // "org=secret,org2=secret2" -> Map(secret -> org)
  const map = new Map();
  for (const pair of (value || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0) map.set(pair.slice(i + 1), pair.slice(0, i));
  }
  return map;
}

export function configFromEnv(env = process.env) {
  const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tokens = parsePairs(env.ORGCHAT_TOKENS);
  if (env.ORGCHAT_TOKEN) tokens.set(env.ORGCHAT_TOKEN, env.ORGCHAT_ORG || 'default');
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '0.0.0.0',
    tokens, // secret -> org
    bridgeTokens: parsePairs(env.ORGCHAT_BRIDGE_TOKENS), // secret -> org; may act for any user of that org
    panelTokens: parsePairs(env.ORGCHAT_PANEL_TOKENS), // secret -> org; read-only panel access
    oidc: env.ORGCHAT_OIDC_ISSUER
      ? {
          issuer: env.ORGCHAT_OIDC_ISSUER,
          audience: list(env.ORGCHAT_OIDC_AUDIENCE),
          jwksUrl: env.ORGCHAT_OIDC_JWKS_URL || '',
          allowedDomains: list(env.ORGCHAT_OIDC_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
          org: env.ORGCHAT_OIDC_ORG || '',
        }
      : null,
    dbPath: env.ORGCHAT_DB || 'orgchat.db',
    requireE2E: env.ORGCHAT_REQUIRE_E2E === '1',
    maxMessageBytes: Number(env.ORGCHAT_MAX_MESSAGE_BYTES || 64 * 1024),
    queueLimit: Number(env.ORGCHAT_QUEUE_LIMIT || 100),
    queueTtlMs: Number(env.ORGCHAT_QUEUE_TTL_MS || 7 * 24 * 3600 * 1000),
    historyMs: Number(env.ORGCHAT_HISTORY_DAYS || 30) * 24 * 3600 * 1000,
    ratePerMinute: Number(env.ORGCHAT_RATE_PER_MINUTE || 30),
    auditContent: env.ORGCHAT_AUDIT_CONTENT === '1',
    log: (event) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'),
  };
}

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function lookupSecret(map, secret) {
  if (typeof secret !== 'string' || !secret) return null;
  for (const [s, org] of map) if (safeEqual(secret, s)) return org;
  return null;
}

export function createRelay(cfg) {
  const log = cfg.log || (() => {});
  const verifyIdToken = cfg.oidc ? createOidcVerifier(cfg.oidc) : null;
  const store = openStore(cfg.dbPath, { keepPlaintext: cfg.auditContent });

  // Live connections: `${org}\0${sid}` -> session (with .ws)
  const live = new Map();
  const key = (org, sid) => `${org}\0${sid}`;
  const recentSince = () => Date.now() - cfg.queueTtlMs;

  async function authenticate(auth, claimedUser) {
    if (auth?.token) {
      const org = lookupSecret(cfg.tokens, auth.token);
      if (!org) throw new Error('invalid token');
      return { org, user: clean(claimedUser, 128) || 'unknown', verified: false };
    }
    if (auth?.bridge_token) {
      const org = lookupSecret(cfg.bridgeTokens, auth.bridge_token);
      if (!org) throw new Error('invalid bridge token');
      const user = clean(claimedUser, 128);
      if (!user) throw new Error('bridge sessions must name a user');
      return { org, user, verified: true };
    }
    if (auth?.id_token && typeof auth.id_token === 'string') {
      if (!verifyIdToken) throw new Error('OIDC login is not enabled on this relay');
      const { email, domain } = await verifyIdToken(auth.id_token);
      return { org: cfg.oidc.org || domain, user: email, verified: true };
    }
    throw new Error('missing credentials');
  }

  // ---------------------------------------------------------------------------
  // HTTP: health, panel, panel API
  // ---------------------------------------------------------------------------

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function panelOrg(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return m ? lookupSecret(cfg.panelTokens, m[1]) : null;
  }

  function sessionView(row) {
    return {
      sid: row.sid, name: row.name, user: row.user, agent: row.agent, host: row.host, cwd: row.cwd,
      verified: !!row.verified, e2e: !!row.pubkey, online: !!row.online || live.has(key(row.org, row.sid)),
      connected_at: row.connected_at, last_seen: new Date(row.last_seen).toISOString(),
    };
  }

  function messageView(row) {
    const body = row.body && !row.e2e ? JSON.parse(row.body) : null;
    return {
      seq: row.seq, id: row.id, ts: row.ts, thread: row.thread, bytes: row.bytes, e2e: !!row.e2e, status: row.status,
      from: { sid: row.from_sid, name: row.from_name, user: row.from_user, agent: row.from_agent },
      to: { sid: row.to_sid, name: row.to_name, user: row.to_user, agent: row.to_agent },
      ...(cfg.auditContent && body ? { text: body.text } : {}),
    };
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok\n');
    }
    if (url.pathname === '/panel' || url.pathname === '/panel/') {
      if (!cfg.panelTokens.size) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('panel disabled: set ORGCHAT_PANEL_TOKENS on the relay\n');
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        'x-frame-options': 'DENY',
      });
      return res.end(PANEL_HTML);
    }
    if (url.pathname.startsWith('/api/')) {
      const org = panelOrg(req);
      if (!org) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/api/overview') {
        const day = Date.now() - 24 * 3600 * 1000;
        const sessions = store.sessionsForOrg(org, day).map(sessionView);
        return json(res, 200, {
          org,
          relay: { require_e2e: cfg.requireE2E, keeps_plaintext: cfg.auditContent, history_days: cfg.historyMs / 86400000 },
          stats_24h: store.stats(org, day),
          sessions,
        });
      }
      if (url.pathname === '/api/messages') {
        const before = Number(url.searchParams.get('before')) || undefined;
        const limit = Number(url.searchParams.get('limit')) || 100;
        return json(res, 200, { messages: store.messagesForOrg(org, { before, limit }).map(messageView) });
      }
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('orgchat relay: connect with a WebSocket client\n');
  });

  // ---------------------------------------------------------------------------
  // WebSocket: agents
  // ---------------------------------------------------------------------------

  const wss = new WebSocketServer({ server: httpServer, maxPayload: cfg.maxMessageBytes * 4 + 16384 });

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function publicInfo(s) {
    return {
      sid: s.sid, name: s.name, user: s.user, agent: s.agent, host: s.host, cwd: s.cwd,
      since: s.connectedAt ?? s.connected_at, ...(s.pubkey ? { pubkey: s.pubkey } : {}),
    };
  }

  function flush(session) {
    for (const row of store.pending(session.org, session.sid)) {
      send(session.ws, { type: 'msg', ...rowToWire(row) });
      store.markSent(row.id);
    }
  }

  /** A session record (live or recently seen) by sid. */
  function sessionBySid(org, sid) {
    const l = live.get(key(org, sid));
    if (l) return { ...publicInfo(l), online: true };
    const row = store.getSession(org, sid, recentSince());
    return row ? { ...publicInfo(row), online: false } : null;
  }

  function resolveTargets(org, to, fromSid) {
    const online = [...live.values()].filter((s) => s.org === org);
    if (to.startsWith('user:')) {
      const user = to.slice(5).toLowerCase();
      const hits = online.filter((s) => s.user.toLowerCase() === user && s.sid !== fromSid);
      if (!hits.length) throw new Error(`no online sessions for user ${to.slice(5)}`);
      return hits.map((s) => ({ ...publicInfo(s), online: true }));
    }
    if (SID_RE.test(to)) {
      const s = sessionBySid(org, to);
      if (s) return [s];
    }
    const byName = online.filter((s) => s.name === to);
    if (byName.length === 1) return [{ ...publicInfo(byName[0]), online: true }];
    if (byName.length > 1) throw new Error(`name "${to}" is ambiguous; use a session id: ${byName.map((s) => s.sid).join(', ')}`);
    const offline = store.sessionsByName(org, to, recentSince());
    if (offline.length === 1) return [{ ...publicInfo(offline[0]), online: false }];
    if (offline.length > 1) throw new Error(`name "${to}" is ambiguous; use a session id: ${offline.map((s) => s.sid).join(', ')}`);
    throw new Error(`no session named or with id "${to}" (use list_peers)`);
  }

  function validEnvelope(e2e) {
    return e2e && typeof e2e.alg === 'string' && e2e.alg.length < 64
      && typeof e2e.nonce === 'string' && B64URL_RE.test(e2e.nonce) && e2e.nonce.length <= 32
      && typeof e2e.ct === 'string' && B64URL_RE.test(e2e.ct);
  }

  wss.on('connection', (ws, req) => {
    let session = null;
    let authenticating = false;
    let tokens = cfg.ratePerMinute;
    let lastRefill = Date.now();
    const remote = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 10_000);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      if (!session) {
        if (authenticating) return;
        if (msg.type !== 'hello') return ws.close(4001, 'expected hello');
        authenticating = true;
        clearTimeout(helloTimer);
        const s = msg.session || {};
        try {
          if (!SID_RE.test(s.sid || '')) throw new Error('invalid session id');
          if (s.pubkey !== undefined && !PUBKEY_RE.test(s.pubkey)) throw new Error('invalid public key');
          if (cfg.requireE2E && !s.pubkey) throw new Error('this relay requires end-to-end encryption; upgrade your orgchat client');
          const who = await authenticate(msg.auth, s.user);
          if (ws.readyState !== ws.OPEN) throw new Error('client went away during login');
          const existing = live.get(key(who.org, s.sid)) || store.getSession(who.org, s.sid, 0);
          if (existing && existing.user !== who.user) throw new Error('session id belongs to another user');
          const prev = live.get(key(who.org, s.sid));
          if (prev?.ws && prev.ws !== ws) prev.ws.close(4002, 'replaced by a newer connection');
          session = {
            ws,
            sid: s.sid,
            org: who.org,
            user: who.user,
            verified: who.verified,
            name: clean(s.name, 96) || s.sid,
            agent: clean(s.agent, 40) || 'unknown',
            host: clean(s.host, 64),
            cwd: clean(s.cwd, 256),
            client: clean(s.client, 64),
            pubkey: s.pubkey || null,
            connectedAt: new Date().toISOString(),
          };
          live.set(key(session.org, session.sid), session);
          store.upsertSession(session);
        } catch (err) {
          session = null;
          log({ event: 'auth_failed', remote, error: err.message });
          return ws.close(4001, clean(err.message, 120));
        }
        send(ws, { type: 'welcome', session: { ...publicInfo(session), org: session.org, verified: session.verified } });
        log({ event: 'connect', org: session.org, user: session.user, agent: session.agent, sid: session.sid, name: session.name, e2e: !!session.pubkey, remote });
        flush(session);
        return;
      }

      const reply = (ok, payload) => send(ws, { type: 'res', req: msg.req, ok, ...(ok ? { data: payload } : { error: payload }) });

      switch (msg.type) {
        case 'ack':
          store.markAcked(session.org, session.sid, String(msg.id));
          return;
        case 'list': {
          const peers = [...live.values()].filter((s) => s.org === session.org).map(publicInfo);
          return reply(true, { peers });
        }
        case 'resolve': {
          try {
            return reply(true, { targets: resolveTargets(session.org, clean(msg.to, 200), session.sid) });
          } catch (err) {
            return reply(false, err.message);
          }
        }
        case 'send': {
          const now = Date.now();
          tokens = Math.min(cfg.ratePerMinute, tokens + ((now - lastRefill) / 60_000) * cfg.ratePerMinute);
          lastRefill = now;
          if (tokens < 1) return reply(false, 'rate limit exceeded, slow down');
          tokens -= 1;

          // Envelopes: [{ to: sid, e2e: {...} } | { to: sid, text }]; legacy form: { to, text }.
          let envelopes;
          try {
            if (Array.isArray(msg.envelopes)) {
              if (!msg.envelopes.length || msg.envelopes.length > 50) throw new Error('need 1-50 envelopes');
              envelopes = msg.envelopes.map((e) => {
                const target = sessionBySid(session.org, clean(e?.to, 40));
                if (!target) throw new Error(`unknown session ${clean(e?.to, 40)}`);
                return { target, e2e: e.e2e, text: e.text };
              });
            } else {
              envelopes = resolveTargets(session.org, clean(msg.to, 200), session.sid).map((target) => ({ target, text: msg.text }));
            }
            for (const e of envelopes) {
              if (e.e2e !== undefined) {
                if (!validEnvelope(e.e2e)) throw new Error('malformed encrypted envelope');
                if (e.e2e.ct.length > Math.ceil((cfg.maxMessageBytes + 256) * 4 / 3) + 4) throw new Error(`message exceeds ${cfg.maxMessageBytes} bytes`);
                e.bytes = Math.floor(e.e2e.ct.length * 3 / 4);
              } else {
                if (cfg.requireE2E) throw new Error('this relay requires end-to-end encryption');
                if (typeof e.text !== 'string' || !e.text) throw new Error('empty message');
                e.bytes = Buffer.byteLength(e.text);
                if (e.bytes > cfg.maxMessageBytes) throw new Error(`message exceeds ${cfg.maxMessageBytes} bytes`);
              }
            }
          } catch (err) {
            return reply(false, err.message);
          }

          const thread = msg.thread ? clean(msg.thread, 64) : null;
          const from = { sid: session.sid, name: session.name, user: session.user, agent: session.agent, verified: session.verified, pubkey: session.pubkey };
          const results = envelopes.map(({ target, e2e, text, bytes }) => {
            const id = 'm_' + crypto.randomBytes(8).toString('hex');
            const ts = new Date().toISOString();
            store.insertMessage({ id, org: session.org, from, to: target, thread, ts, bytes, e2e: e2e || null, text });
            store.enforceQueueLimit(session.org, target.sid, cfg.queueLimit);
            const t = live.get(key(session.org, target.sid));
            if (t) {
              const wire = { id, from, to: target.sid, ...(thread ? { thread } : {}), ts, ...(e2e ? { e2e } : { text }) };
              if (!from.pubkey) delete wire.from.pubkey;
              send(t.ws, { type: 'msg', ...wire });
              store.markSent(id);
            }
            log({
              event: 'message', org: session.org, id, from: session.sid, from_user: session.user, to: target.sid, to_user: target.user,
              bytes, e2e: !!e2e, delivered: !!t, ...(cfg.auditContent && !e2e ? { text } : {}),
            });
            return { id, to: target.sid, name: target.name, user: target.user, e2e: !!e2e, status: t ? 'delivered' : 'queued' };
          });
          return reply(true, { sent: results });
        }
        default:
          return reply(false, `unknown request type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!session || live.get(key(session.org, session.sid))?.ws !== ws) return;
      live.delete(key(session.org, session.sid));
      store.setOffline(session.org, session.sid);
      log({ event: 'disconnect', org: session.org, user: session.user, sid: session.sid });
    });
  });

  const sweeper = setInterval(() => store.sweep({ queueTtlMs: cfg.queueTtlMs, historyMs: cfg.historyMs }), 60_000);
  sweeper.unref();

  return {
    store,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address().port)));
    },
    close() {
      clearInterval(sweeper);
      for (const client of wss.clients) client.terminate();
      return new Promise((resolve) => wss.close(() => httpServer.close(() => { store.close(); resolve(); })));
    },
  };
}

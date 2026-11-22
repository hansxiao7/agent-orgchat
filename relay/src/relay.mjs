// orgchat relay: routes plain-text messages between Claude Code sessions that
// belong to the same organization. State is in memory: run one instance.

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createOidcVerifier } from './oidc.mjs';

const SID_RE = /^s_[a-f0-9]{6,32}$/;

export function configFromEnv(env = process.env) {
  const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tokens = new Map();
  for (const pair of list(env.ORGCHAT_TOKENS)) {
    const i = pair.indexOf('=');
    if (i > 0) tokens.set(pair.slice(i + 1), pair.slice(0, i));
  }
  if (env.ORGCHAT_TOKEN) tokens.set(env.ORGCHAT_TOKEN, env.ORGCHAT_ORG || 'default');
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '0.0.0.0',
    tokens, // secret -> org
    oidc: env.ORGCHAT_OIDC_ISSUER
      ? {
          issuer: env.ORGCHAT_OIDC_ISSUER,
          audience: list(env.ORGCHAT_OIDC_AUDIENCE),
          jwksUrl: env.ORGCHAT_OIDC_JWKS_URL || '',
          allowedDomains: list(env.ORGCHAT_OIDC_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
          org: env.ORGCHAT_OIDC_ORG || '',
        }
      : null,
    maxMessageBytes: Number(env.ORGCHAT_MAX_MESSAGE_BYTES || 64 * 1024),
    queueLimit: Number(env.ORGCHAT_QUEUE_LIMIT || 100),
    queueTtlMs: Number(env.ORGCHAT_QUEUE_TTL_MS || 24 * 3600 * 1000),
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

export function createRelay(cfg) {
  const log = cfg.log || (() => {});
  const verifyIdToken = cfg.oidc ? createOidcVerifier(cfg.oidc) : null;

  // org -> { sessions: Map<sid, Session> }
  // A Session outlives its socket for queueTtlMs so queued messages survive reconnects.
  const orgs = new Map();
  const getOrg = (name) => {
    if (!orgs.has(name)) orgs.set(name, { sessions: new Map() });
    return orgs.get(name);
  };

  async function authenticate(auth, claimedUser) {
    if (auth?.token && typeof auth.token === 'string') {
      for (const [secret, org] of cfg.tokens) {
        if (safeEqual(auth.token, secret)) return { org, user: clean(claimedUser, 128) || 'unknown', verified: false };
      }
      throw new Error('invalid token');
    }
    if (auth?.id_token && typeof auth.id_token === 'string') {
      if (!verifyIdToken) throw new Error('OIDC login is not enabled on this relay');
      const { email, domain } = await verifyIdToken(auth.id_token);
      return { org: cfg.oidc.org || domain, user: email, verified: true };
    }
    throw new Error('missing credentials');
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('orgchat relay: connect with a WebSocket client\n');
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: cfg.maxMessageBytes * 2 + 4096 });

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function publicInfo(s) {
    return { sid: s.sid, name: s.name, user: s.user, host: s.host, cwd: s.cwd, since: s.connectedAt };
  }

  function deliver(session, msg) {
    if (session.ws) {
      session.unacked.set(msg.id, msg);
      send(session.ws, { type: 'msg', ...msg });
      return true;
    }
    session.queue.push(msg);
    if (session.queue.length > cfg.queueLimit) session.queue.splice(0, session.queue.length - cfg.queueLimit);
    return false;
  }

  function resolveTargets(org, to, fromSid) {
    const all = [...org.sessions.values()];
    if (to.startsWith('user:')) {
      const user = to.slice(5).toLowerCase();
      const hits = all.filter((s) => s.ws && s.user.toLowerCase() === user && s.sid !== fromSid);
      if (!hits.length) throw new Error(`no online sessions for user ${to.slice(5)}`);
      return hits;
    }
    const bySid = org.sessions.get(to);
    if (bySid) return [bySid];
    const online = all.filter((s) => s.ws && s.name === to);
    if (online.length === 1) return online;
    if (online.length > 1) {
      throw new Error(`name "${to}" is ambiguous; use a session id: ${online.map((s) => s.sid).join(', ')}`);
    }
    const offline = all.filter((s) => s.name === to);
    if (offline.length === 1) return offline;
    throw new Error(`no session named or with id "${to}" (use list_peers)`);
  }

  wss.on('connection', (ws, req) => {
    let session = null;
    let org = null;
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
          const who = await authenticate(msg.auth, s.user);
          if (ws.readyState !== ws.OPEN) throw new Error('client went away during login');
          org = getOrg(who.org);
          const existing = org.sessions.get(s.sid);
          if (existing && existing.user !== who.user) throw new Error('session id belongs to another user');
          session = existing || { sid: s.sid, queue: [], unacked: new Map() };
          if (session.ws && session.ws !== ws) session.ws.close(4002, 'replaced by a newer connection');
          Object.assign(session, {
            ws,
            org: who.org,
            user: who.user,
            verified: who.verified,
            name: clean(s.name, 96) || s.sid,
            host: clean(s.host, 64),
            cwd: clean(s.cwd, 256),
            client: clean(s.client, 64),
            connectedAt: new Date().toISOString(),
            lastSeen: Date.now(),
          });
          org.sessions.set(session.sid, session);
        } catch (err) {
          session = null;
          log({ event: 'auth_failed', remote, error: err.message });
          return ws.close(4001, clean(err.message, 120));
        }
        send(ws, { type: 'welcome', session: { ...publicInfo(session), org: session.org, verified: session.verified } });
        log({ event: 'connect', org: session.org, user: session.user, sid: session.sid, name: session.name, remote });
        for (const queued of session.queue.splice(0)) deliver(session, queued);
        return;
      }

      session.lastSeen = Date.now();
      const reply = (ok, payload) => send(ws, { type: 'res', req: msg.req, ok, ...(ok ? { data: payload } : { error: payload }) });

      switch (msg.type) {
        case 'ack':
          session.unacked.delete(msg.id);
          return;
        case 'list': {
          const peers = [...org.sessions.values()].filter((s) => s.ws).map(publicInfo);
          return reply(true, { peers });
        }
        case 'send': {
          const now = Date.now();
          tokens = Math.min(cfg.ratePerMinute, tokens + ((now - lastRefill) / 60_000) * cfg.ratePerMinute);
          lastRefill = now;
          if (tokens < 1) return reply(false, 'rate limit exceeded, slow down');
          tokens -= 1;

          const text = typeof msg.text === 'string' ? msg.text : '';
          if (!text) return reply(false, 'empty message');
          if (Buffer.byteLength(text) > cfg.maxMessageBytes) return reply(false, `message exceeds ${cfg.maxMessageBytes} bytes`);
          const to = clean(msg.to, 200);
          let targets;
          try {
            targets = resolveTargets(org, to, session.sid);
          } catch (err) {
            return reply(false, err.message);
          }
          const results = targets.map((t) => {
            const out = {
              id: 'm_' + crypto.randomBytes(8).toString('hex'),
              from: { sid: session.sid, name: session.name, user: session.user, verified: session.verified },
              to: t.sid,
              text,
              ...(msg.thread ? { thread: clean(msg.thread, 64) } : {}),
              ts: new Date().toISOString(),
            };
            const delivered = deliver(t, out);
            log({
              event: 'message',
              org: session.org,
              id: out.id,
              from: session.sid,
              from_user: session.user,
              to: t.sid,
              to_user: t.user,
              bytes: Buffer.byteLength(text),
              delivered,
              ...(cfg.auditContent ? { text } : {}),
            });
            return { id: out.id, to: t.sid, name: t.name, user: t.user, status: delivered ? 'delivered' : 'queued' };
          });
          return reply(true, { sent: results });
        }
        default:
          return reply(false, `unknown request type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!session || session.ws !== ws) return;
      session.ws = null;
      session.lastSeen = Date.now();
      // Messages that were sent but never acknowledged go back to the queue.
      session.queue.unshift(...session.unacked.values());
      session.unacked.clear();
      log({ event: 'disconnect', org: session.org, user: session.user, sid: session.sid });
    });
  });

  // Forget offline sessions (and their queues) after queueTtlMs.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - cfg.queueTtlMs;
    for (const org of orgs.values()) {
      for (const [sid, s] of org.sessions) {
        if (!s.ws && s.lastSeen < cutoff) org.sessions.delete(sid);
      }
    }
  }, 60_000);
  sweeper.unref();

  return {
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address().port)));
    },
    close() {
      clearInterval(sweeper);
      for (const client of wss.clients) client.terminate();
      return new Promise((resolve) => wss.close(() => httpServer.close(() => resolve())));
    },
  };
}

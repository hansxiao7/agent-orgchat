// SQLite persistence for the relay (node:sqlite, no extra dependencies).
// Keeps: sessions (so offline sessions stay addressable), the offline queue
// (survives relay restarts), and message history metadata for the panel.
// Message bodies are dropped once delivered, unless keepPlaintext is set, and
// encrypted bodies are always dropped (the relay can't read them anyway).

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  org TEXT NOT NULL, sid TEXT NOT NULL,
  user TEXT NOT NULL, name TEXT NOT NULL, agent TEXT, host TEXT, cwd TEXT, client TEXT,
  pubkey TEXT, verified INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT, last_seen INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org, sid)
);
CREATE INDEX IF NOT EXISTS sessions_name ON sessions (org, name);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, org TEXT NOT NULL,
  from_sid TEXT NOT NULL, from_user TEXT, from_name TEXT, from_agent TEXT, from_pubkey TEXT, from_verified INTEGER,
  to_sid TEXT NOT NULL, to_user TEXT, to_name TEXT, to_agent TEXT,
  thread TEXT, ts TEXT NOT NULL, created INTEGER NOT NULL, bytes INTEGER NOT NULL, e2e INTEGER NOT NULL,
  body TEXT, status TEXT NOT NULL, delivered_at TEXT, acked_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages (org, to_sid, status);
CREATE INDEX IF NOT EXISTS messages_org ON messages (org, seq);
`;

export function openStore(path = ':memory:', { keepPlaintext = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // After a restart nobody is connected.
  db.exec('UPDATE sessions SET online = 0');

  const q = (sql) => db.prepare(sql);
  const stmts = {
    upsertSession: q(`INSERT INTO sessions (org, sid, user, name, agent, host, cwd, client, pubkey, verified, connected_at, last_seen, online)
      VALUES (:org, :sid, :user, :name, :agent, :host, :cwd, :client, :pubkey, :verified, :connected_at, :last_seen, 1)
      ON CONFLICT (org, sid) DO UPDATE SET user = :user, name = :name, agent = :agent, host = :host, cwd = :cwd, client = :client,
        pubkey = :pubkey, verified = :verified, connected_at = :connected_at, last_seen = :last_seen, online = 1`),
    setOffline: q('UPDATE sessions SET online = 0, last_seen = ? WHERE org = ? AND sid = ?'),
    getSession: q('SELECT * FROM sessions WHERE org = ? AND sid = ? AND last_seen >= ?'),
    byName: q('SELECT * FROM sessions WHERE org = ? AND name = ? AND last_seen >= ? ORDER BY last_seen DESC'),
    insertMessage: q(`INSERT INTO messages (id, org, from_sid, from_user, from_name, from_agent, from_pubkey, from_verified,
        to_sid, to_user, to_name, to_agent, thread, ts, created, bytes, e2e, body, status)
      VALUES (:id, :org, :from_sid, :from_user, :from_name, :from_agent, :from_pubkey, :from_verified,
        :to_sid, :to_user, :to_name, :to_agent, :thread, :ts, :created, :bytes, :e2e, :body, 'queued')`),
    pending: q(`SELECT * FROM messages WHERE org = ? AND to_sid = ? AND status IN ('queued', 'sent') ORDER BY seq`),
    markSent: q(`UPDATE messages SET status = 'sent', delivered_at = coalesce(delivered_at, ?) WHERE id = ? AND status != 'acked'`),
    markAcked: q(`UPDATE messages SET status = 'acked', acked_at = ?,
      body = CASE WHEN e2e = 0 AND ? = 1 THEN body ELSE NULL END WHERE id = ? AND org = ? AND to_sid = ?`),
    countPending: q(`SELECT count(*) AS n FROM messages WHERE org = ? AND to_sid = ? AND status IN ('queued', 'sent')`),
    expireOldest: q(`UPDATE messages SET status = 'dropped', body = NULL WHERE seq IN (
      SELECT seq FROM messages WHERE org = ? AND to_sid = ? AND status IN ('queued', 'sent') ORDER BY seq LIMIT ?)`),
    expireQueued: q(`UPDATE messages SET status = 'expired', body = NULL WHERE status IN ('queued', 'sent') AND created < ?`),
    deleteOldMessages: q('DELETE FROM messages WHERE created < ?'),
    deleteOldSessions: q('DELETE FROM sessions WHERE online = 0 AND last_seen < ?'),
    sessionsForOrg: q('SELECT * FROM sessions WHERE org = ? AND (online = 1 OR last_seen >= ?) ORDER BY online DESC, last_seen DESC LIMIT 500'),
    messagesForOrg: q(`SELECT * FROM messages WHERE org = ? AND seq < ? ORDER BY seq DESC LIMIT ?`),
    stats: q(`SELECT count(*) AS total, sum(e2e) AS e2e,
        sum(CASE WHEN status IN ('queued', 'sent') THEN 1 ELSE 0 END) AS pending,
        count(DISTINCT from_user) AS senders
      FROM messages WHERE org = ? AND created >= ?`),
  };

  const s = {
    upsertSession(row) {
      stmts.upsertSession.run({
        org: row.org, sid: row.sid, user: row.user, name: row.name, agent: row.agent || null, host: row.host || null,
        cwd: row.cwd || null, client: row.client || null, pubkey: row.pubkey || null, verified: row.verified ? 1 : 0,
        connected_at: row.connectedAt, last_seen: Date.now(),
      });
    },
    setOffline(org, sid) {
      stmts.setOffline.run(Date.now(), org, sid);
    },
    getSession(org, sid, since) {
      return stmts.getSession.get(org, sid, since) || null;
    },
    sessionsByName(org, name, since) {
      return stmts.byName.all(org, name, since);
    },
    insertMessage(m) {
      stmts.insertMessage.run({
        id: m.id, org: m.org,
        from_sid: m.from.sid, from_user: m.from.user, from_name: m.from.name, from_agent: m.from.agent || null,
        from_pubkey: m.from.pubkey || null, from_verified: m.from.verified ? 1 : 0,
        to_sid: m.to.sid, to_user: m.to.user, to_name: m.to.name, to_agent: m.to.agent || null,
        thread: m.thread || null, ts: m.ts, created: Date.now(), bytes: m.bytes, e2e: m.e2e ? 1 : 0,
        body: JSON.stringify(m.e2e ? { e2e: m.e2e } : { text: m.text }),
      });
    },
    pending(org, sid) {
      return stmts.pending.all(org, sid);
    },
    markSent(id) {
      stmts.markSent.run(new Date().toISOString(), id);
    },
    markAcked(org, sid, id) {
      stmts.markAcked.run(new Date().toISOString(), keepPlaintext ? 1 : 0, id, org, sid);
    },
    enforceQueueLimit(org, sid, limit) {
      const { n } = stmts.countPending.get(org, sid);
      if (n > limit) stmts.expireOldest.run(org, sid, n - limit);
    },
    sweep({ queueTtlMs, historyMs }) {
      const now = Date.now();
      stmts.expireQueued.run(now - queueTtlMs);
      stmts.deleteOldMessages.run(now - historyMs);
      stmts.deleteOldSessions.run(now - historyMs);
    },
    // Panel queries
    sessionsForOrg(org, since) {
      return stmts.sessionsForOrg.all(org, since);
    },
    messagesForOrg(org, { before = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
      return stmts.messagesForOrg.all(org, before, Math.min(limit, 500));
    },
    stats(org, since) {
      return stmts.stats.get(org, since);
    },
    close() {
      db.close();
    },
  };
  return s;
}

/** Turn a stored message row back into the wire format delivered to clients. */
export function rowToWire(row) {
  const body = row.body ? JSON.parse(row.body) : {};
  return {
    id: row.id,
    from: {
      sid: row.from_sid, name: row.from_name, user: row.from_user, agent: row.from_agent,
      verified: !!row.from_verified, ...(row.from_pubkey ? { pubkey: row.from_pubkey } : {}),
    },
    to: row.to_sid,
    ...(row.thread ? { thread: row.thread } : {}),
    ts: row.ts,
    ...(body.e2e ? { e2e: body.e2e } : { text: body.text ?? '' }),
  };
}

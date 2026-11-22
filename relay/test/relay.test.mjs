// Relay features exercised through the shared client library:
// persistence across restarts, the panel API, bridge auth, requireE2E, crypto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelay, configFromEnv } from '../src/relay.mjs';
import { RelayClient, newSessionId } from '../../client/lib/relay-client.mjs';
import { loadIdentity, KnownKeys, encrypt, decrypt } from '../../client/lib/e2e.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orgchat-relay-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function device() {
  const dir = path.join(TMP, `dev${++seq}`);
  return { identity: loadIdentity(path.join(dir, 'id.json')), knownKeys: new KnownKeys(path.join(dir, 'kk.json')) };
}

function config(url, over = {}) {
  return { relayUrl: url, token: 'acme-secret', user: 'u', name: 'n', host: 'h', cwd: '/', e2e: true, requireE2E: false, configFile: '-', ...over };
}

async function connect(url, over = {}, opts = {}) {
  const inbox = [];
  const waiters = [];
  const c = new RelayClient(config(url, over), {
    ...device(),
    reconnect: false,
    ...opts,
    onMessage: (m) => { inbox.push(m); waiters.splice(0).forEach((w) => w()); },
  });
  c.inbox = inbox;
  c.next = async () => {
    for (let i = 0; i < 100 && !inbox.length; i++) await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    if (!inbox.length) throw new Error('no message');
    return inbox.shift();
  };
  c.connect();
  await c.ready();
  return c;
}

function relayConfig(env = {}) {
  return { ...configFromEnv({ ORGCHAT_TOKENS: 'acme=acme-secret', ORGCHAT_DB: ':memory:', ...env }), log: () => {} };
}

test('offline queue survives a relay restart (SQLite)', async () => {
  const db = path.join(TMP, 'restart.db');
  let relay = createRelay(relayConfig({ ORGCHAT_DB: db }));
  let url = `ws://127.0.0.1:${await relay.listen(0, '127.0.0.1')}`;

  const bobSid = newSessionId();
  const bobDevice = device();
  const bob = await connect(url, { user: 'bob', name: 'bob' }, { sid: bobSid, ...bobDevice });
  bob.close();
  await new Promise((r) => setTimeout(r, 50));

  const alice = await connect(url, { user: 'alice', name: 'alice' });
  const res = await alice.sendMessage(bobSid, 'see you after the restart');
  assert.equal(res.sent[0].status, 'queued');
  assert.equal(res.sent[0].e2e, true);
  alice.close();
  await relay.close();

  relay = createRelay(relayConfig({ ORGCHAT_DB: db }));
  url = `ws://127.0.0.1:${await relay.listen(0, '127.0.0.1')}`;
  const bob2 = await connect(url, { user: 'bob', name: 'bob' }, { sid: bobSid, ...bobDevice });
  const m = await bob2.next();
  assert.equal(m.text, 'see you after the restart');
  assert.equal(m.e2e, true);
  assert.equal(m.from.user, 'alice');
  bob2.close();
  await relay.close();
});

test('panel: disabled without tokens, authenticated API shows metadata but never ciphertext', async () => {
  const off = createRelay(relayConfig());
  const offPort = await off.listen(0, '127.0.0.1');
  assert.equal((await fetch(`http://127.0.0.1:${offPort}/panel`)).status, 404);
  await off.close();

  const relay = createRelay(relayConfig({ ORGCHAT_PANEL_TOKENS: 'acme=panel-secret' }));
  const port = await relay.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${port}`;
  const a = await connect(url, { user: 'alice', name: 'alice-api' }, { agent: 'codex' });
  const b = await connect(url, { user: 'bob', name: 'bob-web' }, { agent: 'cursor' });
  await a.sendMessage('bob-web', 'top secret plan', { thread: 'x1' });
  await b.next();

  const page = await fetch(`http://127.0.0.1:${port}/panel`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /orgchat panel/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { authorization: 'Bearer acme-secret' } })).status, 401);

  const auth = { headers: { authorization: 'Bearer panel-secret' } };
  const ov = await (await fetch(`http://127.0.0.1:${port}/api/overview`, auth)).json();
  assert.equal(ov.org, 'acme');
  assert.deepEqual(ov.sessions.filter((s) => s.online).map((s) => s.agent).sort(), ['codex', 'cursor']);
  assert.equal(ov.stats_24h.total, 1);
  assert.equal(ov.stats_24h.e2e, 1);

  const raw = await (await fetch(`http://127.0.0.1:${port}/api/messages`, auth)).text();
  assert.doesNotMatch(raw, /top secret plan/);
  const { messages } = JSON.parse(raw);
  assert.equal(messages[0].e2e, true);
  assert.equal(messages[0].from.agent, 'codex');
  assert.equal(messages[0].thread, 'x1');
  assert.equal(messages[0].text, undefined);
  a.close(); b.close();
  await relay.close();
});

test('bridge token may act for a named user and is marked verified', async () => {
  const relay = createRelay(relayConfig({ ORGCHAT_BRIDGE_TOKENS: 'acme=bridge-secret' }));
  const url = `ws://127.0.0.1:${await relay.listen(0, '127.0.0.1')}`;
  const human = await connect(url, { token: '', bridgeToken: 'bridge-secret', user: 'carol@acme.com', name: 'Carol (lark)' }, { agent: 'human-lark' });
  assert.equal(human.me.verified, true);
  assert.equal(human.me.user, 'carol@acme.com');
  assert.equal(human.me.agent, 'human-lark');
  human.close();
  await assert.rejects(connect(url, { token: '', bridgeToken: 'wrong', user: 'x' }), /invalid bridge token/);
  await relay.close();
});

test('relay with requireE2E refuses clients without keys', async () => {
  const relay = createRelay(relayConfig({ ORGCHAT_REQUIRE_E2E: '1' }));
  const url = `ws://127.0.0.1:${await relay.listen(0, '127.0.0.1')}`;
  await assert.rejects(connect(url, { e2e: false }), /requires end-to-end encryption/);
  const ok = await connect(url, { user: 'a' });
  ok.close();
  await relay.close();
});

test('ciphertext is bound to sender, recipient and thread', () => {
  const a = device().identity;
  const b = device().identity;
  const c = device().identity;
  const bind = { fromSid: 's_aaaaaa', toSid: 's_bbbbbb', thread: 't' };
  const env = encrypt(a, b.pub, 'hi', bind);
  assert.equal(decrypt(b, a.pub, env, bind).text, 'hi');
  assert.throws(() => decrypt(b, a.pub, env, { ...bind, toSid: 's_cccccc' }));
  assert.throws(() => decrypt(b, a.pub, env, { ...bind, thread: 'other' }));
  assert.throws(() => decrypt(c, a.pub, env, bind));
  assert.throws(() => decrypt(b, c.pub, env, bind));
  const tampered = { ...env, ct: env.ct.slice(0, -2) + (env.ct.endsWith('A') ? 'BB' : 'AA') };
  assert.throws(() => decrypt(b, a.pub, tampered, bind));
});

test('known keys: new, then known, and a second key for the same user is flagged', () => {
  const kk = new KnownKeys(path.join(TMP, 'kk-test.json'));
  const k1 = device().identity.pub;
  const k2 = device().identity.pub;
  assert.equal(kk.check('alice', k1).status, 'new');
  assert.equal(kk.check('alice', k1).status, 'known');
  const second = kk.check('alice', k2);
  assert.equal(second.status, 'new');
  assert.equal(second.otherKeys, 1);
});

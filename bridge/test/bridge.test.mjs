// Bridge core against a real relay, with a fake IM platform standing in for Lark/Slack.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/core.mjs';
import { createRelay, configFromEnv } from '../../relay/src/relay.mjs';
import { RelayClient } from '../../client/lib/relay-client.mjs';
import { loadIdentity, KnownKeys } from '../../client/lib/e2e.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orgchat-bridge-test-'));

function fakeIM() {
  const users = {
    U1: { email: 'carol@acme.com', name: 'Carol' },
    U2: { email: 'mallory@evil.com', name: 'Mallory' },
    U3: { email: '', name: 'NoEmail' },
  };
  let seq = 0;
  const outbox = []; // { userId, text, ref, replyTo? }
  const waiters = [];
  const push = (m) => { outbox.push(m); waiters.splice(0).forEach((w) => w()); };
  const im = {
    name: 'fake',
    outbox,
    refOwner: new Map(),
    async start(onInbound) { im.onInbound = onInbound; },
    async lookupUser(userId) { return users[userId]; },
    async sendToUser(userId, text) { const ref = `m${++seq}`; im.refOwner.set(ref, userId); push({ userId, text, ref }); return ref; },
    async reply(ref, text) { const userId = im.refOwner.get(ref); const r = `m${++seq}`; im.refOwner.set(r, userId); push({ userId, text, ref: r, replyTo: ref }); return r; },
    // The person types a DM (optionally as a reply to a message).
    async dm(userId, text, replyTo = null) { const ref = `in${++seq}`; im.refOwner.set(ref, userId); await im.onInbound({ userId, text, ref, replyTo }); return ref; },
    async nextFor(userId, match = () => true) {
      for (let i = 0; i < 100; i++) {
        const idx = outbox.findIndex((m) => m.userId === userId && match(m));
        if (idx >= 0) return outbox.splice(idx, 1)[0];
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
      throw new Error(`no IM message for ${userId}; outbox: ${JSON.stringify(outbox)}`);
    },
  };
  return im;
}

let relay, url, im, bridge, agent;
const agentInbox = [];

async function nextAgentMessage() {
  for (let i = 0; i < 100 && !agentInbox.length; i++) await new Promise((r) => setTimeout(r, 30));
  if (!agentInbox.length) throw new Error('agent got nothing');
  return agentInbox.shift();
}

before(async () => {
  relay = createRelay({ ...configFromEnv({ ORGCHAT_TOKENS: 'acme=acme-secret', ORGCHAT_BRIDGE_TOKENS: 'acme=bridge-secret', ORGCHAT_DB: ':memory:' }), log: () => {} });
  url = `ws://127.0.0.1:${await relay.listen(0, '127.0.0.1')}`;
  im = fakeIM();
  bridge = new Bridge({ adapter: im, relayUrl: url, bridgeToken: 'bridge-secret', stateDir: path.join(TMP, 'bridge'), allowedDomains: ['acme.com'] });
  await bridge.start();

  agent = new RelayClient(
    { relayUrl: url, token: 'acme-secret', user: 'bob', name: 'bob-codex', host: 'h', cwd: '/', e2e: true, configFile: '-' },
    { agent: 'codex', reconnect: false, identity: loadIdentity(path.join(TMP, 'agent', 'id.json')), knownKeys: new KnownKeys(path.join(TMP, 'agent', 'kk.json')), onMessage: (m) => agentInbox.push(m) },
  );
  agent.connect();
  await agent.ready();
});

after(async () => {
  bridge.stop();
  agent.close();
  await relay.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a person asks an agent from IM, the agent answers, the person replies in thread', async () => {
  await im.dm('U1', '@bob-codex is staging migrated?');
  const q = await nextAgentMessage();
  assert.equal(q.text, 'is staging migrated?');
  assert.equal(q.e2e, true);
  assert.equal(q.from.user, 'carol@acme.com');
  assert.equal(q.from.agent, 'human-fake');
  assert.equal(q.from.verified, true);
  assert.match(q.thread, /^t_/);
  const confirm = await im.nextFor('U1', (m) => /sent to bob-codex/.test(m.text));
  assert.match(confirm.text, /🔒/);

  await agent.sendMessage(q.from.sid, 'yes, migration 0042 ran at 10:02', { thread: q.thread });
  const shown = await im.nextFor('U1', (m) => /0042/.test(m.text));
  assert.match(shown.text, /bob-codex · codex · bob 🔒/);
  assert.match(shown.text, /Reply to this message/);

  await im.dm('U1', 'thanks, deploying now', shown.ref);
  const r = await nextAgentMessage();
  assert.equal(r.text, 'thanks, deploying now');
  assert.equal(r.thread, q.thread);
});

test('an agent can message a person first, by user', async () => {
  const res = await agent.sendMessage('user:carol@acme.com', 'heads up: main is red');
  assert.equal(res.sent[0].e2e, true);
  const shown = await im.nextFor('U1', (m) => /main is red/.test(m.text));
  // A plain message without @ goes back to the last peer.
  await im.dm('U1', 'on it');
  assert.equal((await nextAgentMessage()).text, 'on it');
  await im.nextFor('U1', (m) => /sent to bob-codex/.test(m.text));
  void shown;
});

test('peers, help, unknown targets and access control', async () => {
  await im.dm('U1', 'peers');
  const peers = await im.nextFor('U1', (m) => /bob-codex/.test(m.text));
  assert.match(peers.text, /\[codex\]/);

  await im.dm('U1', 'help');
  await im.nextFor('U1', (m) => /orgchat bridge/.test(m.text));

  await im.dm('U1', '@nobody hello');
  await im.nextFor('U1', (m) => /Not sent: no session named/.test(m.text));

  await im.dm('U2', '@bob-codex let me in');
  await im.nextFor('U2', (m) => /evil\.com accounts are not allowed/.test(m.text));

  await im.dm('U3', 'hi');
  await im.nextFor('U3', (m) => /could not read your email/.test(m.text));
  assert.equal(agentInbox.length, 0);
});

test('bridge state persists people and their stable session ids', async () => {
  await new Promise((r) => setTimeout(r, 300));
  const state = JSON.parse(fs.readFileSync(path.join(TMP, 'bridge', 'state.json'), 'utf8'));
  assert.deepEqual(state.humans.map((h) => h.email), ['carol@acme.com']);
  assert.equal(bridge.sidFor('U1'), bridge.sidFor('U1'));
  assert.ok(state.refs.length > 0);
});

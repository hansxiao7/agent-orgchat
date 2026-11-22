// End-to-end: real relay + real plugin MCP servers talking MCP over stdio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRelay, configFromEnv } from '../src/relay.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugin/server/orgchat.mjs');

class McpClient {
  constructor(env) {
    this.proc = spawn(process.execPath, [PLUGIN], {
      env: { ...process.env, ORGCHAT_CONFIG: '/nonexistent', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.waiting = new Map();
    this.notifications = [];
    this.listeners = [];
    this.stderr = '';
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)(msg);
        this.waiting.delete(msg.id);
      } else if (msg.method) {
        this.notifications.push(msg);
        for (const l of this.listeners.splice(0)) l();
      }
    });
  }
  rpc(method, params = {}) {
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }
  async init() {
    const res = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return res.result;
  }
  async tool(name, args = {}) {
    const res = await this.rpc('tools/call', { name, arguments: args });
    const text = res.result.content[0].text;
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { isError: !!res.result.isError, data };
  }
  async waitConnected() {
    for (let i = 0; i < 100; i++) {
      const { data } = await this.tool('whoami');
      if (data.status === 'connected') return data;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('never connected: ' + this.stderr);
  }
  async nextNotification(method) {
    for (;;) {
      const hit = this.notifications.find((n) => n.method === method);
      if (hit) {
        this.notifications.splice(this.notifications.indexOf(hit), 1);
        return hit;
      }
      await Promise.race([
        new Promise((r) => this.listeners.push(r)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for ' + method)), 3000)),
      ]);
    }
  }
  close() { this.proc.kill(); }
}

let relay, url;
const clients = [];
const client = (env) => { const c = new McpClient({ ORGCHAT_RELAY_URL: url, ...env }); clients.push(c); return c; };

before(async () => {
  const cfg = { ...configFromEnv({ ORGCHAT_TOKENS: 'acme=acme-secret,other=other-secret' }), log: () => {} };
  relay = createRelay(cfg);
  const port = await relay.listen(0, '127.0.0.1');
  url = `ws://127.0.0.1:${port}`;
});

after(async () => {
  for (const c of clients) c.close();
  await relay.close();
});

test('initialize advertises the channel capability and tools', async () => {
  const a = client({ ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'alice', ORGCHAT_NAME: 'alice-init' });
  const init = await a.init();
  assert.deepEqual(init.capabilities.experimental, { 'claude/channel': {} });
  assert.match(init.instructions, /NOT from your user/);
  const list = await a.rpc('tools/list');
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['list_peers', 'read_inbox', 'send', 'whoami']);
});

test('two sessions in one org can discover each other and exchange messages', async () => {
  const alice = client({ ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'alice', ORGCHAT_NAME: 'alice-api' });
  const bob = client({ ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'bob', ORGCHAT_NAME: 'bob-web' });
  await Promise.all([alice.init(), bob.init()]);
  const [a, b] = await Promise.all([alice.waitConnected(), bob.waitConnected()]);
  assert.equal(a.session.org, 'acme');

  const peers = await alice.tool('list_peers');
  const names = peers.data.peers.map((p) => p.name);
  assert.ok(names.includes('bob-web'));
  assert.ok(peers.data.peers.find((p) => p.name === 'alice-api').you);

  const sent = await alice.tool('send', { to: 'bob-web', text: 'what port does the API run on?', thread: 't1' });
  assert.equal(sent.isError, false);
  assert.equal(sent.data.sent[0].status, 'delivered');

  const n = await bob.nextNotification('notifications/claude/channel');
  assert.equal(n.params.content, 'what port does the API run on?');
  assert.equal(n.params.meta.from_user, 'alice');
  assert.equal(n.params.meta.from_session, a.session.sid);
  assert.equal(n.params.meta.thread_id, 't1');
  for (const k of Object.keys(n.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/);

  const inbox = await bob.tool('read_inbox');
  assert.equal(inbox.data.messages.length, 1);
  assert.equal((await bob.tool('read_inbox')).data, 'No new messages.');

  await bob.tool('send', { to: n.params.meta.from_session, text: '8080', thread: 't1' });
  const back = await alice.nextNotification('notifications/claude/channel');
  assert.equal(back.params.content, '8080');
  assert.equal(back.params.meta.from_session, b.session.sid);

  const byUser = await alice.tool('send', { to: 'user:bob', text: 'ping' });
  assert.equal(byUser.data.sent.length, 1);
  await bob.nextNotification('notifications/claude/channel');
});

test('sessions in different orgs cannot see or reach each other', async () => {
  const carol = client({ ORGCHAT_TOKEN: 'other-secret', ORGCHAT_USER: 'carol', ORGCHAT_NAME: 'carol-x' });
  await carol.init();
  const c = await carol.waitConnected();
  assert.equal(c.session.org, 'other');
  const peers = await carol.tool('list_peers');
  assert.deepEqual(peers.data.peers.map((p) => p.name), ['carol-x']);
  const res = await carol.tool('send', { to: 'bob-web', text: 'hi' });
  assert.equal(res.isError, true);
  assert.match(res.data, /no session/);
});

test('a bad token is rejected and reported by whoami', async () => {
  const mallory = client({ ORGCHAT_TOKEN: 'wrong', ORGCHAT_USER: 'mallory' });
  await mallory.init();
  let who;
  for (let i = 0; i < 60; i++) {
    who = (await mallory.tool('whoami')).data;
    if (who.last_error) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.notEqual(who.status, 'connected');
  assert.match(who.last_error, /invalid token/);
  const res = await mallory.tool('list_peers');
  assert.equal(res.isError, true);
});

test('unconfigured plugin explains what to set', async () => {
  const c = new McpClient({ ORGCHAT_RELAY_URL: '' });
  clients.push(c);
  await c.init();
  const who = (await c.tool('whoami')).data;
  assert.equal(who.status, 'unconfigured');
  assert.match(who.last_error, /ORGCHAT_RELAY_URL/);
});

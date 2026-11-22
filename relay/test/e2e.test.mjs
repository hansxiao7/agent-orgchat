// End-to-end: real relay + real plugin MCP servers talking MCP over stdio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRelay, configFromEnv } from '../src/relay.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/bin/orgchat-mcp.mjs');

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
  async init(clientName = 'claude-code') {
    const res = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '0' } });
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
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['list_peers', 'read_inbox', 'send', 'wait_for_message', 'whoami']);
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

test('different agents talk to each other: Codex pulls, Claude Code gets pushed', async () => {
  const codex = client({ ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'dave', ORGCHAT_NAME: 'dave-codex' });
  const claude = client({ ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'erin', ORGCHAT_NAME: 'erin-claude' });
  const cursor = client({ ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'frank', ORGCHAT_NAME: 'frank-cursor' });
  await Promise.all([codex.init('codex-mcp-client'), claude.init('claude-code'), cursor.init('cursor-vscode')]);
  const [cx] = await Promise.all([codex.waitConnected(), claude.waitConnected(), cursor.waitConnected()]);
  assert.equal(cx.session.agent, 'codex');
  assert.match(cx.push, /pull/);

  const peers = (await codex.tool('list_peers')).data.peers;
  const agentOf = (n) => peers.find((p) => p.name === n)?.agent;
  assert.equal(agentOf('erin-claude'), 'claude-code');
  assert.equal(agentOf('frank-cursor'), 'cursor');

  // Codex asks Claude Code; Claude Code receives a channel push that names the sender's agent.
  await codex.tool('send', { to: 'erin-claude', text: 'which DB migration is next?', thread: 'mig' });
  const pushed = await claude.nextNotification('notifications/claude/channel');
  assert.equal(pushed.params.meta.from_agent, 'codex');

  // Codex waits for the answer (no push for non-Claude clients).
  const waiting = codex.tool('wait_for_message', { timeout_seconds: 5, thread: 'mig' });
  await claude.tool('send', { to: pushed.params.meta.from_session, text: '0042_add_orders', thread: 'mig' });
  const got = await waiting;
  assert.equal(got.data.messages[0].text, '0042_add_orders');
  assert.equal(got.data.messages[0].from_agent, 'claude-code');
  assert.equal(codex.notifications.filter((n) => n.method === 'notifications/claude/channel').length, 0);

  // Cursor learns about unread mail from any tool result.
  await codex.tool('send', { to: 'frank-cursor', text: 'review my PR?' });
  let who;
  for (let i = 0; i < 40; i++) {
    who = await cursor.rpc('tools/call', { name: 'whoami', arguments: {} });
    if (/unread peer message/.test(who.result.content[0].text)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.match(who.result.content[0].text, /1 unread peer message/);
  const inbox = (await cursor.tool('read_inbox')).data;
  assert.equal(inbox.messages[0].text, 'review my PR?');

  const timedOut = await cursor.tool('wait_for_message', { timeout_seconds: 1 });
  assert.match(timedOut.data, /No messages within 1s/);
});

test('CLI can list peers and send with --wait', async () => {
  const cli = path.resolve(path.dirname(PLUGIN), 'orgchat.mjs');
  const env = { ...process.env, ORGCHAT_CONFIG: '/nonexistent', ORGCHAT_RELAY_URL: url, ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'gina' };
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], { env, timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

  const gemini = client({ ORGCHAT_TOKEN: 'acme-secret', ORGCHAT_USER: 'hank', ORGCHAT_NAME: 'hank-gemini' });
  await gemini.init('gemini-cli-mcp-client');
  await gemini.waitConnected();

  const peers = await run(['peers']);
  assert.equal(peers.code, 0, peers.stderr);
  assert.match(peers.stdout, /gemini-cli\thank\thank-gemini/);

  const sending = run(['send', 'hank-gemini', 'are', 'you', 'there?', '--wait', '10', '--json']);
  const got = await gemini.tool('wait_for_message', { timeout_seconds: 5 });
  assert.equal(got.data.messages[0].text, 'are you there?');
  assert.equal(got.data.messages[0].from_agent, 'cli');
  await gemini.tool('send', { to: got.data.messages[0].from_session, text: 'yes' });
  const res = await sending;
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout.trim()).text, 'yes');

  const bad = await run(['send']);
  assert.equal(bad.code, 1);
});

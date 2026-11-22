// Shared orgchat relay client used by the MCP server and the CLI.
// Zero dependencies: uses the WebSocket client built into Node.js >= 22.

import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnownKeys, decrypt, encrypt, isPublicKey, loadIdentity } from './e2e.mjs';

export const VERSION = '0.3.0';
const REQUEST_TIMEOUT_MS = 10_000;

/** Config: environment variables override ~/.config/orgchat/config.json */
export function loadConfig({ log = () => {} } = {}) {
  const env = process.env;
  const file = env.ORGCHAT_CONFIG || path.join(os.homedir(), '.config', 'orgchat', 'config.json');
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`could not read ${file}: ${err.message}`);
  }
  const localUser = os.userInfo().username;
  const host = os.hostname().split('.')[0];
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  return {
    configFile: file,
    relayUrl: env.ORGCHAT_RELAY_URL || fromFile.relayUrl || '',
    token: env.ORGCHAT_TOKEN || fromFile.token || '',
    idTokenCommand: env.ORGCHAT_ID_TOKEN_CMD || fromFile.idTokenCommand || '',
    user: env.ORGCHAT_USER || fromFile.user || localUser,
    name: env.ORGCHAT_NAME || fromFile.name || `${localUser}@${host}:${path.basename(projectDir)}`,
    agent: env.ORGCHAT_AGENT || fromFile.agent || '',
    // End-to-end encryption: on by default; requireE2E refuses to send or accept plaintext.
    e2e: (env.ORGCHAT_E2E ?? (fromFile.e2e === false ? '0' : '1')) !== '0',
    requireE2E: (env.ORGCHAT_REQUIRE_E2E ?? (fromFile.requireE2E ? '1' : '0')) === '1',
    host,
    cwd: projectDir,
  };
}

/** Turn an MCP clientInfo.name into a short, recognizable agent label. */
export function agentLabel(clientName) {
  const n = String(clientName || '').toLowerCase();
  if (!n) return 'unknown';
  const known = [
    [/claude/, 'claude-code'],
    [/codex/, 'codex'],
    [/cursor/, 'cursor'],
    [/gemini/, 'gemini-cli'],
    [/windsurf|codeium/, 'windsurf'],
    [/roo/, 'roo-code'],
    [/cline/, 'cline'],
    [/opencode/, 'opencode'],
    [/continue/, 'continue'],
    [/cherry/, 'cherry-studio'],
    [/copilot|vscode|visual studio code/, 'vscode'],
    [/zed/, 'zed'],
    [/goose/, 'goose'],
  ];
  for (const [re, label] of known) if (re.test(n)) return label;
  return n.replace(/[^a-z0-9._-]+/g, '-').slice(0, 40);
}

export function newSessionId() {
  return 's_' + crypto.randomBytes(5).toString('hex');
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) reject(new Error(`idTokenCommand failed: ${err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Connects to the relay, keeps the connection alive with backoff, acks
 * incoming messages and calls onMessage(msg) for each one.
 */
export class RelayClient {
  constructor(config, { sid = newSessionId(), agent = 'unknown', client = `orgchat/${VERSION}`, onMessage = () => {}, onStatus = () => {}, reconnect = true, identity, knownKeys } = {}) {
    this.config = config;
    this.identity = config.e2e || config.requireE2E ? identity || loadIdentity() : null;
    this.knownKeys = this.identity ? knownKeys || new KnownKeys() : null;
    this.seen = new Set();
    this.sid = sid;
    this.agent = agent;
    this.client = client;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.reconnect = reconnect;
    this.ws = null;
    this.state = 'disconnected';
    this.me = null;
    this.lastError = null;
    this.backoffMs = 1000;
    this.reqSeq = 0;
    this.pending = new Map();
    this.timer = null;
    this.closed = false;
  }

  async connect() {
    const { config } = this;
    if (!config.relayUrl) {
      return this.setState('unconfigured', `No relay configured. Set ORGCHAT_RELAY_URL or relayUrl in ${config.configFile}.`);
    }
    if (typeof WebSocket !== 'function') {
      return this.setState('unconfigured', `Node.js ${process.version} has no built-in WebSocket; orgchat needs Node.js 22 or newer.`);
    }
    this.setState('connecting', this.lastError);
    let auth;
    try {
      if (config.bridgeToken) auth = { bridge_token: config.bridgeToken };
      else if (config.idTokenCommand) auth = { id_token: await runCommand(config.idTokenCommand) };
      else if (config.token) auth = { token: config.token };
      else throw new Error('No credentials. Set ORGCHAT_TOKEN or ORGCHAT_ID_TOKEN_CMD (or token / idTokenCommand in the config file).');
    } catch (err) {
      return this.fail(err.message);
    }

    const ws = new WebSocket(config.relayUrl);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'hello',
        v: 1,
        auth,
        session: {
          sid: this.sid,
          name: config.name,
          user: config.user,
          agent: this.agent,
          host: config.host,
          cwd: config.cwd,
          client: this.client,
          ...(this.identity ? { pubkey: this.identity.pub } : {}),
        },
      }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      this.onRelayMessage(msg);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.me = null;
      for (const { reject } of this.pending.values()) reject(new Error('relay connection closed'));
      this.pending.clear();
      if (this.closed) return this.setState('closed', null);
      // 4001 = auth rejected, 4002 = replaced by a newer connection for this session
      if (ev.code === 4002) return this.setState('disconnected', 'replaced by another connection with the same session id');
      this.fail(ev.reason || `connection closed (${ev.code})`, ev.code === 4001 ? 60_000 : undefined);
    };
  }

  setState(state, error) {
    this.state = state;
    this.lastError = error ?? null;
    this.onStatus(state, this.lastError);
  }

  fail(message, delayMs) {
    this.setState('disconnected', message);
    if (!this.reconnect || this.closed) return;
    const delay = delayMs ?? this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref?.();
  }

  onRelayMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.backoffMs = 1000;
        this.me = msg.session;
        this.setState('connected', null);
        break;
      case 'msg': {
        this.ws?.send(JSON.stringify({ type: 'ack', id: msg.id }));
        if (this.seen.has(msg.id)) break; // redelivery after a dropped ack
        this.seen.add(msg.id);
        if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
        const m = this.open(msg);
        if (m) this.onMessage(m);
        break;
      }
      case 'res': {
        const p = this.pending.get(msg.req);
        if (!p) return;
        this.pending.delete(msg.req);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'relay error'));
        break;
      }
      case 'error':
        this.lastError = msg.error;
        break;
    }
  }

  /** Decrypt / validate an incoming relay message into { id, from, to, thread, ts, text, e2e, ... }. */
  open(msg) {
    const base = { id: msg.id, from: msg.from, to: msg.to, thread: msg.thread, ts: msg.ts };
    if (msg.e2e) {
      const senderPub = msg.from?.pubkey;
      try {
        if (!this.identity) throw new Error('encryption is disabled on this client');
        if (!isPublicKey(senderPub)) throw new Error('sender has no public key');
        const { text, sentAt } = decrypt(this.identity, senderPub, msg.e2e, { fromSid: msg.from.sid, toSid: msg.to, thread: msg.thread });
        const pin = this.knownKeys.check(msg.from.user, senderPub);
        return { ...base, text, sentAt, e2e: true, senderKey: pin.status, senderFingerprint: pin.fingerprint, senderOtherKeys: pin.otherKeys };
      } catch (err) {
        return { ...base, text: `[orgchat: could not decrypt this message: ${err.message}]`, e2e: true, decryptError: err.message };
      }
    }
    if (this.config.requireE2E) {
      return { ...base, text: '[orgchat: dropped an unencrypted message because requireE2E is on]', e2e: false, decryptError: 'plaintext refused' };
    }
    return { ...base, text: String(msg.text ?? ''), e2e: false };
  }

  /**
   * Send text to a target (session id, name, or user:<user>). Encrypts for every
   * recipient that has a public key; plaintext for the rest unless requireE2E.
   */
  async sendMessage(to, text, { thread } = {}) {
    const { targets } = await this.request('resolve', { to });
    const plainTargets = targets.filter((t) => !(this.identity && isPublicKey(t.pubkey)));
    if (plainTargets.length && this.config.requireE2E) {
      throw new Error(`refusing to send unencrypted (requireE2E): ${plainTargets.map((t) => t.name).join(', ')} ${this.identity ? 'have no public key' : ''}`);
    }
    const envelopes = targets.map((t) =>
      this.identity && isPublicKey(t.pubkey)
        ? { to: t.sid, e2e: encrypt(this.identity, t.pubkey, text, { fromSid: this.sid, toSid: t.sid, thread }) }
        : { to: t.sid, text },
    );
    return this.request('send', { envelopes, ...(thread ? { thread } : {}) });
  }

  /** Resolves once connected, rejects on a terminal failure or timeout. */
  ready(timeoutMs = 15_000) {
    if (this.state === 'connected') return Promise.resolve(this.me);
    return new Promise((resolve, reject) => {
      const prev = this.onStatus;
      const timer = setTimeout(() => done(new Error(this.lastError || 'timed out connecting to relay')), timeoutMs);
      const done = (err) => {
        clearTimeout(timer);
        this.onStatus = prev;
        err ? reject(err) : resolve(this.me);
      };
      this.onStatus = (state, error) => {
        prev(state, error);
        if (state === 'connected') done();
        else if (state === 'unconfigured' || (!this.reconnect && state === 'disconnected')) done(new Error(error || state));
      };
    });
  }

  request(type, payload) {
    if (this.state !== 'connected' || !this.ws) {
      return Promise.reject(new Error(`orgchat is ${this.state}${this.lastError ? `: ${this.lastError}` : ''}`));
    }
    const req = ++this.reqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req);
        reject(new Error('relay did not answer in time'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req, {
        resolve: (d) => { clearTimeout(timer); resolve(d); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ type, req, ...payload }));
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, 'bye');
  }
}

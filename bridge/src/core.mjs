// Platform-agnostic IM bridge: every person who DMs the bot gets a stable
// orgchat session (agent "human-<platform>"), so AI agents can message people
// and people can answer in Lark/Feishu or Slack.
//
// The bridge is an end-to-end encryption endpoint: it decrypts messages for
// the people it represents and hands the plaintext to the IM platform.
//
// Adapter interface:
//   name: string
//   start(onInbound)              onInbound({ userId, text, ref, replyTo })
//   lookupUser(userId)            -> { email, name }
//   sendToUser(userId, text)      -> ref of the posted message
//   reply(ref, text)              -> ref, posts in the thread of ref

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RelayClient } from '../../client/lib/relay-client.mjs';
import { KnownKeys, fingerprint, isPublicKey, loadIdentity } from '../../client/lib/e2e.mjs';

const MAX_REFS = 5000;

export const HELP = `orgchat bridge: talk to the AI agents in your organization.

  @<session> <message>   send to a session (name or id), e.g. @bob-codex is staging migrated?
  @user:<email> <msg>    send to every session of one person
  reply to a message     answers the agent that sent it, in the same thread
  <message>              goes to whoever you talked to last
  peers                  list sessions that are online
  help                   this text`;

export class Bridge {
  constructor({ adapter, relayUrl, bridgeToken, token, stateDir, allowedDomains = [], requireE2E = false, log = () => {} }) {
    this.adapter = adapter;
    this.relayUrl = relayUrl;
    this.bridgeToken = bridgeToken;
    this.token = token;
    this.stateDir = stateDir;
    this.allowedDomains = allowedDomains.map((d) => d.toLowerCase());
    this.requireE2E = requireE2E;
    this.log = log;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.identity = loadIdentity(path.join(stateDir, 'identity.json'));
    this.knownKeys = new KnownKeys(path.join(stateDir, 'known_keys.json'));
    this.humans = new Map(); // platform userId -> human
    this.sessions = new Map(); // platform userId -> RelayClient
    this.refs = new Map(); // IM message ref -> { userId, peerSid, peerName, thread }
    this.seenInbound = new Set();
    this.load();
  }

  // --- persistence --------------------------------------------------------

  file(name) {
    return path.join(this.stateDir, name);
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file('state.json'), 'utf8'));
      for (const h of data.humans || []) this.humans.set(h.userId, h);
      for (const [ref, conv] of data.refs || []) this.refs.set(ref, conv);
    } catch (err) {
      if (err.code !== 'ENOENT') this.log({ event: 'state_read_failed', error: err.message });
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data = { humans: [...this.humans.values()], refs: [...this.refs.entries()].slice(-MAX_REFS) };
      fs.writeFileSync(this.file('state.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
    }, 200);
    this.saveTimer.unref?.();
  }

  remember(ref, conv) {
    if (!ref) return;
    this.refs.set(ref, conv);
    if (this.refs.size > MAX_REFS) this.refs.delete(this.refs.keys().next().value);
    this.save();
  }

  // --- sessions -----------------------------------------------------------

  sidFor(userId) {
    return 's_' + crypto.createHash('sha256').update(`${this.adapter.name}:${userId}`).digest('hex').slice(0, 12);
  }

  session(human) {
    let client = this.sessions.get(human.userId);
    if (client) return client;
    client = new RelayClient(
      {
        relayUrl: this.relayUrl,
        bridgeToken: this.bridgeToken,
        token: this.token,
        user: human.email,
        name: `${human.name} (${this.adapter.name})`,
        host: this.adapter.name,
        cwd: '',
        e2e: true,
        requireE2E: this.requireE2E,
        configFile: '-',
      },
      {
        sid: this.sidFor(human.userId),
        agent: `human-${this.adapter.name}`,
        client: `orgchat-bridge/${this.adapter.name}`,
        identity: this.identity,
        knownKeys: this.knownKeys,
        onMessage: (m) => this.toHuman(human, m).catch((err) => this.log({ event: 'deliver_failed', user: human.email, error: err.message })),
        onStatus: (state, error) => error && this.log({ event: 'relay_status', user: human.email, state, error }),
      },
    );
    this.sessions.set(human.userId, client);
    client.connect();
    return client;
  }

  async start() {
    for (const human of this.humans.values()) this.session(human);
    await this.adapter.start((evt) => this.onInbound(evt).catch((err) => this.log({ event: 'inbound_failed', error: err.message })));
    this.log({ event: 'bridge_started', platform: this.adapter.name, humans: this.humans.size, fingerprint: this.identity.fingerprint });
  }

  stop() {
    for (const c of this.sessions.values()) c.close();
    clearTimeout(this.saveTimer);
  }

  // --- agent -> human -----------------------------------------------------

  async toHuman(human, m) {
    const from = m.from || {};
    const lock = m.decryptError ? '⚠️ could not decrypt' : m.e2e ? '🔒' : '(unencrypted)';
    const lines = [`💬 ${from.name} · ${from.agent || '?'} · ${from.user} ${lock}${m.thread ? `  #${m.thread}` : ''}`];
    if (m.senderKey === 'new' && m.senderOtherKeys > 0) {
      lines.push(`⚠️ New encryption key for ${from.user} (fingerprint ${m.senderFingerprint}). Expected if they use a new machine; otherwise check with them.`);
    }
    lines.push('', m.text, '', '↩︎ Reply to this message to answer.');
    const ref = await this.adapter.sendToUser(human.userId, lines.join('\n'));
    this.remember(ref, { userId: human.userId, peerSid: from.sid, peerName: from.name, thread: m.thread || null });
    human.lastPeer = { sid: from.sid, name: from.name };
    this.save();
  }

  // --- human -> agent -----------------------------------------------------

  async resolveHuman(userId) {
    const known = this.humans.get(userId);
    if (known) return known;
    const { email, name } = await this.adapter.lookupUser(userId);
    if (!email) throw new Error('I could not read your email address, so I cannot tell which organization you belong to. Ask your admin to grant the bot permission to read user emails.');
    const domain = email.split('@')[1] || '';
    if (this.allowedDomains.length && !this.allowedDomains.includes(domain)) {
      throw new Error(`Sorry, ${domain} accounts are not allowed on this orgchat bridge.`);
    }
    const human = { userId, email, name: name || email, joined: new Date().toISOString() };
    this.humans.set(userId, human);
    this.save();
    this.log({ event: 'human_joined', platform: this.adapter.name, user: email });
    return human;
  }

  async onInbound({ userId, text, ref, replyTo }) {
    if (ref && this.seenInbound.has(ref)) return; // platforms may redeliver events
    if (ref) {
      this.seenInbound.add(ref);
      if (this.seenInbound.size > 2000) this.seenInbound.delete(this.seenInbound.values().next().value);
    }
    const say = (t) => (ref ? this.adapter.reply(ref, t) : this.adapter.sendToUser(userId, t));

    let human;
    try {
      human = await this.resolveHuman(userId);
    } catch (err) {
      return say(err.message);
    }
    const client = this.session(human);
    const body = String(text || '').trim();

    if (/^\/?help$/i.test(body) || !body) return say(HELP);
    try {
      await client.ready(10_000);
    } catch (err) {
      return say(`⚠️ Not connected to the orgchat relay: ${err.message}`);
    }

    if (/^\/?peers$/i.test(body)) {
      const { peers } = await client.request('list', {});
      const others = peers.filter((p) => p.sid !== client.sid);
      if (!others.length) return say('Nobody else is online right now.');
      return say(others.map((p) => `• ${p.name}  [${p.agent || '?'}]  ${p.user}  ${isPublicKey(p.pubkey) ? '🔒' : '(unencrypted)'}\n  @${p.sid}`).join('\n'));
    }

    // Work out who this is for.
    let target, thread, implicit = false;
    const conv = replyTo ? this.refs.get(replyTo) : null;
    const at = /^@(\S+)\s+([\s\S]+)$/.exec(body);
    let message = body;
    if (conv && conv.userId === userId) {
      target = conv.peerSid;
      thread = conv.thread || newThread();
    } else if (at) {
      target = at[1];
      message = at[2];
      thread = newThread();
    } else if (human.lastPeer) {
      target = human.lastPeer.sid;
      implicit = true;
    } else {
      return say(`Who should get this? Start with @<session>, e.g. "@bob-codex ${body.slice(0, 40)}". Send "peers" to see who is online.`);
    }

    let res;
    try {
      res = await client.sendMessage(target, message, { thread });
    } catch (err) {
      return say(`⚠️ Not sent: ${err.message}`);
    }
    const first = res.sent[0];
    human.lastPeer = { sid: first.to, name: first.name };
    this.save();
    // Replies to our confirmation (or to the person's own message) continue the same conversation.
    const conversation = { userId, peerSid: first.to, peerName: first.name, thread: thread || null };
    this.remember(ref, conversation);
    const queued = res.sent.filter((s) => s.status === 'queued');
    const names = res.sent.map((s) => s.name).join(', ');
    if (implicit || queued.length || at) {
      const note = queued.length ? ` (offline, will be delivered when ${queued.map((s) => s.name).join(', ')} reconnects)` : '';
      const confirmRef = await say(`✓ sent to ${names}${res.sent.every((s) => s.e2e) ? ' 🔒' : ''}${note}`);
      this.remember(confirmRef, conversation);
    }
  }
}

function newThread() {
  return 't_' + crypto.randomBytes(4).toString('hex');
}

export { fingerprint };

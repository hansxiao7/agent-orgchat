#!/usr/bin/env node
// orgchat CLI: talk to the agents in your organization from a terminal or script.

import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import { RelayClient, loadConfig, VERSION } from '../lib/relay-client.mjs';
import { fingerprint } from '../lib/e2e.mjs';

const USAGE = `orgchat ${VERSION} — message AI agent sessions in your organization

Usage:
  orgchat whoami                     show identity and connection status
  orgchat peers [--json]             list connected sessions
  orgchat send <to> <text...>        send a message (to = session id, name, or user:<user>)
          [--thread <id>]            thread id to reply in
          [--wait [seconds]]         then wait for the first reply and print it
  orgchat listen [--json]            stay online and print incoming messages
  orgchat chat                       interactive: read and answer messages from agents

Config: ~/.config/orgchat/config.json or ORGCHAT_RELAY_URL / ORGCHAT_TOKEN / ORGCHAT_ID_TOKEN_CMD.
The CLI shows up to peers as agent "cli" (override with ORGCHAT_AGENT, name with ORGCHAT_NAME).`;

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--thread') flags.thread = argv[++i];
    else if (a === '--wait') {
      flags.wait = /^\d+$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 120;
    } else if (a === '-h' || a === '--help') flags.help = true;
    else rest.push(a);
  }
  return { cmd: rest[0], args: rest.slice(1), flags };
}

function printMessage(m, json) {
  if (json) return console.log(JSON.stringify(m));
  const who = `${m.from?.name} (${m.from?.agent || '?'}, ${m.from?.user}, ${m.from?.sid})`;
  const lock = m.e2e && !m.decryptError ? ` 🔒 ${m.senderFingerprint}${m.senderKey === 'new' ? ' (new key)' : ''}` : ' (unencrypted)';
  console.log(`\n[${m.ts}] ${who}${m.thread ? ` #${m.thread}` : ''}${lock}\n${m.text}`);
}

async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  if (!cmd || flags.help) {
    console.log(USAGE);
    process.exit(cmd || flags.help ? 0 : 1);
  }

  const config = loadConfig({ log: (m) => console.error(m) });
  const longLived = cmd === 'listen' || cmd === 'chat';
  if (!process.env.ORGCHAT_NAME && !longLived) config.name = `${config.user}@${config.host}:cli`;
  const queued = [];
  let onMsg = (m) => queued.push(m);
  const relay = new RelayClient(config, {
    agent: config.agent || 'cli',
    client: `orgchat-cli/${VERSION}`,
    reconnect: longLived,
    onMessage: (m) => onMsg(m),
    onStatus: (state, error) => {
      if (longLived && error) console.error(`[orgchat] ${state}: ${error}`);
    },
  });
  relay.connect();

  try {
    switch (cmd) {
      case 'whoami': {
        const me = await relay.ready();
        console.log(JSON.stringify({ relay_url: config.relayUrl, session: me, e2e: relay.identity ? { fingerprint: relay.identity.fingerprint, required: config.requireE2E } : { enabled: false } }, null, 2));
        break;
      }
      case 'peers': {
        await relay.ready();
        const { peers } = await relay.request('list', {});
        if (flags.json) console.log(JSON.stringify(peers, null, 2));
        else for (const p of peers) console.log(`${p.sid}  ${p.agent || '?'}\t${p.user}\t${p.name}\t${p.pubkey ? '🔒 ' + fingerprint(p.pubkey) : 'unencrypted'}`);
        break;
      }
      case 'send': {
        const [to, ...words] = args;
        const text = words.join(' ');
        if (!to || !text) throw new Error('usage: orgchat send <to> <text...>');
        await relay.ready();
        const res = await relay.sendMessage(to, text, { thread: flags.thread });
        for (const s of res.sent) console.error(`${s.status}${s.e2e ? ' 🔒' : ' (unencrypted)'} to ${s.name} (${s.to}) id=${s.id}`);
        if (flags.wait) {
          const targets = new Set(res.sent.map((s) => s.to));
          const reply = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), flags.wait * 1000);
            const check = (m) => {
              if (targets.has(m.from?.sid) || (flags.thread && m.thread === flags.thread)) {
                clearTimeout(timer);
                resolve(m);
              }
            };
            queued.forEach(check);
            onMsg = check;
          });
          if (!reply) throw new Error(`no reply within ${flags.wait}s`);
          printMessage(reply, flags.json);
        }
        break;
      }
      case 'listen': {
        const me = await relay.ready();
        console.error(`[orgchat] listening as ${me.name} (${me.sid}) in org ${me.org}. Ctrl-C to stop.`);
        queued.splice(0).forEach((m) => printMessage(m, flags.json));
        onMsg = (m) => printMessage(m, flags.json);
        await new Promise(() => {});
        break;
      }
      case 'chat': {
        await chat(relay, queued, (fn) => (onMsg = fn));
        break;
      }
      default:
        throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
    }
  } catch (err) {
    console.error(`orgchat: ${err.message}`);
    process.exitCode = 1;
  } finally {
    relay.close();
  }
}

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

async function chat(relay, queued, setHandler) {
  const me = await relay.ready();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let last = null; // { sid, name, thread }
  const print = (text) => {
    process.stdout.write('\r\x1b[K' + text + '\n');
    rl.prompt(true);
  };
  const show = (m) => {
    const lock = m.e2e && !m.decryptError ? '🔒' : '(unencrypted)';
    print(`${bold('◀ ' + m.from?.name)} ${dim(`· ${m.from?.agent || '?'} · ${m.from?.user}`)} ${lock}\n  ${m.text.split('\n').join('\n  ')}`);
    last = { sid: m.from?.sid, name: m.from?.name, thread: m.thread };
  };
  console.log(dim(`orgchat · ${me.name} (${me.org})${relay.identity ? ` · 🔒 ${relay.identity.fingerprint}` : ''}`));
  console.log(dim('Reply, or "@<session> msg" · /peers · /quit'));
  queued.splice(0).forEach(show);
  setHandler(show);
  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === '/quit') break;
    try {
      if (input === '/peers') {
        const { peers } = await relay.request('list', {});
        print(peers.filter((p) => p.sid !== relay.sid).map((p) => `  ${p.name} ${dim(`· ${p.agent || '?'} · ${p.user}`)} ${p.pubkey ? '🔒' : ''}`).join('\n') || '  nobody else is online');
        continue;
      }
      const at = /^@(\S+)\s+([\s\S]+)$/.exec(input);
      const to = at ? at[1] : last?.sid;
      if (!to) { print(dim('Nobody to reply to yet. Start with @<session> <message>.')); continue; }
      const thread = at ? 't_' + crypto.randomBytes(4).toString('hex') : last.thread;
      const res = await relay.sendMessage(to, at ? at[2] : input, { thread });
      const s = res.sent[0];
      if (at) last = { sid: s.to, name: s.name, thread };
      print(dim(`▶ ${s.status} to ${res.sent.map((x) => x.name).join(', ')}${res.sent.every((x) => x.e2e) ? ' 🔒' : ''}`));
    } catch (err) {
      print(`orgchat: ${err.message}`);
    }
  }
  rl.close();
}

main();

#!/usr/bin/env node
// orgchat CLI: talk to the agents in your organization from a terminal or script.

import { RelayClient, loadConfig, VERSION } from '../lib/relay-client.mjs';

const USAGE = `orgchat ${VERSION} — message AI agent sessions in your organization

Usage:
  orgchat whoami                     show identity and connection status
  orgchat peers [--json]             list connected sessions
  orgchat send <to> <text...>        send a message (to = session id, name, or user:<user>)
          [--thread <id>]            thread id to reply in
          [--wait [seconds]]         then wait for the first reply and print it
  orgchat listen [--json]            stay online and print incoming messages

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
  console.log(`\n[${m.ts}] ${who}${m.thread ? ` #${m.thread}` : ''}\n${m.text}`);
}

async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  if (!cmd || flags.help) {
    console.log(USAGE);
    process.exit(cmd || flags.help ? 0 : 1);
  }

  const config = loadConfig({ log: (m) => console.error(m) });
  if (!process.env.ORGCHAT_NAME && cmd !== 'listen') config.name = `${config.user}@${config.host}:cli`;
  const queued = [];
  let onMsg = (m) => queued.push(m);
  const relay = new RelayClient(config, {
    agent: config.agent || 'cli',
    client: `orgchat-cli/${VERSION}`,
    reconnect: cmd === 'listen',
    onMessage: (m) => onMsg(m),
    onStatus: (state, error) => {
      if (cmd === 'listen' && error) console.error(`[orgchat] ${state}: ${error}`);
    },
  });
  relay.connect();

  try {
    switch (cmd) {
      case 'whoami': {
        const me = await relay.ready();
        console.log(JSON.stringify({ relay_url: config.relayUrl, session: me }, null, 2));
        break;
      }
      case 'peers': {
        await relay.ready();
        const { peers } = await relay.request('list', {});
        if (flags.json) console.log(JSON.stringify(peers, null, 2));
        else for (const p of peers) console.log(`${p.sid}  ${p.agent || '?'}\t${p.user}\t${p.name}`);
        break;
      }
      case 'send': {
        const [to, ...words] = args;
        const text = words.join(' ');
        if (!to || !text) throw new Error('usage: orgchat send <to> <text...>');
        await relay.ready();
        const res = await relay.request('send', { to, text, ...(flags.thread ? { thread: flags.thread } : {}) });
        for (const s of res.sent) console.error(`${s.status} to ${s.name} (${s.to}) id=${s.id}`);
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

main();

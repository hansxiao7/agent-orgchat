#!/usr/bin/env node
// orgchat IM bridge: lets people join orgchat conversations from Lark/Feishu or Slack.
import { Bridge } from './src/core.mjs';

const env = process.env;
const log = (event) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const platform = (env.ORGCHAT_BRIDGE_PLATFORM || '').toLowerCase();

function fail(msg) {
  console.error(`orgchat bridge: ${msg}\nSee https://github.com/hansxiao7/agent-orgchat#im-bridge-larkfeishu--slack`);
  process.exit(1);
}

if (!env.ORGCHAT_RELAY_URL) fail('set ORGCHAT_RELAY_URL');
if (!env.ORGCHAT_BRIDGE_TOKEN && !env.ORGCHAT_TOKEN) fail('set ORGCHAT_BRIDGE_TOKEN (recommended) or ORGCHAT_TOKEN');

let adapter;
if (platform === 'lark' || platform === 'feishu') {
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) fail('set LARK_APP_ID and LARK_APP_SECRET');
  const { createLarkAdapter } = await import('./src/lark.mjs');
  adapter = createLarkAdapter({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, domain: platform === 'lark' || env.LARK_DOMAIN === 'lark' ? 'lark' : 'feishu', log });
} else if (platform === 'slack') {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) fail('set SLACK_BOT_TOKEN (xoxb-...) and SLACK_APP_TOKEN (xapp-...)');
  const { createSlackAdapter } = await import('./src/slack.mjs');
  adapter = createSlackAdapter({ botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN, log });
} else {
  fail('set ORGCHAT_BRIDGE_PLATFORM to feishu, lark or slack');
}

const bridge = new Bridge({
  adapter,
  relayUrl: env.ORGCHAT_RELAY_URL,
  bridgeToken: env.ORGCHAT_BRIDGE_TOKEN,
  token: env.ORGCHAT_TOKEN,
  stateDir: env.ORGCHAT_BRIDGE_STATE || './bridge-state',
  allowedDomains: list(env.ORGCHAT_BRIDGE_ALLOWED_DOMAINS),
  requireE2E: env.ORGCHAT_REQUIRE_E2E === '1',
  log,
});
await bridge.start();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { bridge.stop(); process.exit(0); });

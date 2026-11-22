#!/usr/bin/env node
import { configFromEnv, createRelay } from './src/relay.mjs';

const cfg = configFromEnv();
if (!cfg.tokens.size && !cfg.oidc) {
  console.error('orgchat relay: configure ORGCHAT_TOKEN / ORGCHAT_TOKENS and/or ORGCHAT_OIDC_ISSUER. See README.');
  process.exit(1);
}

const relay = createRelay(cfg);
const port = await relay.listen();
cfg.log({
  event: 'listening',
  port,
  auth: [cfg.tokens.size ? 'token' : null, cfg.oidc ? 'oidc' : null].filter(Boolean),
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await relay.close();
    process.exit(0);
  });
}

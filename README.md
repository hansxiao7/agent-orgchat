# claude-orgchat

Let Claude Code sessions message each other **across machines and across people** in the same organization.

Claude Code already lets *your own* sessions talk to each other (`/peers`, `SendMessage`). orgchat is for the next step: Alice's session working on the API can ask Bob's session working on the web app which port it expects, and get an answer, without either human copying text around.

```
   Alice's laptop                                     Bob's laptop
 ┌────────────────────┐                           ┌────────────────────┐
 │ Claude Code        │                           │ Claude Code        │
 │  └ orgchat plugin  │      ┌───────────────┐    │  └ orgchat plugin  │
 │    (MCP server,    │◄────►│ orgchat relay │◄──►│    (MCP server,    │
 │    claude/channel) │  wss │ auth/presence │wss │    claude/channel) │
 └────────────────────┘      │ routing/audit │    └────────────────────┘
                             └───────────────┘
                              (you host it)
```

- **Plugin**: an MCP server bundled as a Claude Code plugin. It registers the session with your relay, gives Claude `list_peers` / `send` / `read_inbox` / `whoami` tools, and pushes incoming messages into the running session as a [channel](https://code.claude.com/docs/en/channels). Zero dependencies: plain Node.js 22+.
- **Relay**: a small WebSocket server you run. It authenticates sessions, scopes them to an organization, routes messages, queues them for sessions that are briefly offline, and writes an audit log. One dependency (`ws`).

> Not affiliated with Anthropic. Channels are a Claude Code research preview; see [Enabling channels](#enabling-channels).

## How it fits with what Claude Code already has

| Need | Use |
|---|---|
| Sessions on the same machine, same user | Built-in `SendMessage` / `/peers`. Nothing to install. |
| Your own sessions on other machines | Built-in, via Remote Control (claude.ai login). |
| Sessions of **different people** in one org | **orgchat** |

To keep the built-in local messaging on for everyone, set `"crossSessionInbound": "accept"` in managed settings (see [`examples/managed-settings.json`](examples/managed-settings.json)).

## Quick start

### 1. Run a relay

```bash
cd relay
npm ci
ORGCHAT_TOKENS="acme=$(openssl rand -hex 24)" npm start
# or: docker build -t orgchat-relay relay && docker run -p 8787:8787 -e ORGCHAT_TOKENS=... orgchat-relay
```

Put it behind TLS (any reverse proxy, Fly.io, Railway, Cloud Run with min instances = 1, etc.) so clients connect with `wss://`. State is in memory, so run exactly **one** instance.

### 2. Install the plugin

In Claude Code:

```
/plugin marketplace add hansxiao7/claude-orgchat
/plugin install orgchat@claude-orgchat
```

### 3. Configure

Create `~/.config/orgchat/config.json` (see [`examples/config.json`](examples/config.json)):

```json
{
  "relayUrl": "wss://orgchat.example.com",
  "token": "the-token-for-your-org",
  "user": "alice@acme.com"
}
```

### 4. Start Claude Code with the channel

While your org hasn't allowlisted the plugin (see below), start sessions with:

```bash
claude --dangerously-load-development-channels plugin:orgchat@claude-orgchat
```

Then just talk to Claude: *"ask bob's web session which port the dev server expects"*. Incoming messages show up in the session as `<channel source="orgchat" ...>` events.

Without channels enabled the tools still work; Claude can poll with `read_inbox`, but messages won't interrupt an idle session.

## Configuration

### Plugin (`~/.config/orgchat/config.json`, env vars override)

| Key | Env var | Description |
|---|---|---|
| `relayUrl` | `ORGCHAT_RELAY_URL` | `wss://...` URL of your relay. |
| `token` | `ORGCHAT_TOKEN` | Shared org token (token auth). |
| `idTokenCommand` | `ORGCHAT_ID_TOKEN_CMD` | Command that prints an OIDC ID token (OIDC auth). Takes precedence over `token`. |
| `user` | `ORGCHAT_USER` | Your display identity in token mode. Ignored in OIDC mode (the verified email is used). Default: OS username. |
| `name` | `ORGCHAT_NAME` | Session name peers see. Default: `user@host:project-dir`. |
| | `ORGCHAT_CONFIG` | Alternative config file path. |

### Relay (env vars)

| Env var | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address. `GET /healthz` returns `ok`. |
| `ORGCHAT_TOKENS` | | Comma-separated `org=token` pairs. Each token admits members of that org. |
| `ORGCHAT_TOKEN` + `ORGCHAT_ORG` | `default` | Single-org shorthand. |
| `ORGCHAT_OIDC_ISSUER` | | Enables OIDC ID-token login (e.g. `https://accounts.google.com`). |
| `ORGCHAT_OIDC_AUDIENCE` | | Required with OIDC. Comma-separated accepted `aud` values. |
| `ORGCHAT_OIDC_ALLOWED_DOMAINS` | | Required with OIDC. Email domains allowed in. |
| `ORGCHAT_OIDC_ORG` | email domain | Put all OIDC users in this org instead of one org per domain. |
| `ORGCHAT_OIDC_JWKS_URL` | discovered | Override JWKS discovery. |
| `ORGCHAT_MAX_MESSAGE_BYTES` | `65536` | Max message size. |
| `ORGCHAT_RATE_PER_MINUTE` | `30` | Messages per minute per connection. |
| `ORGCHAT_QUEUE_LIMIT` / `ORGCHAT_QUEUE_TTL_MS` | `100` / 24h | Offline queue size per session and how long offline sessions are remembered. |
| `ORGCHAT_AUDIT_CONTENT` | off | `1` also logs message bodies (metadata is always logged as JSON lines on stdout). |

### Identity: what "same organization" means

orgchat cannot ask Anthropic which org a claude.ai account belongs to (there is no documented API for third-party plugins, and the plugin never touches Claude Code's credentials). Membership is defined by your relay:

- **Token mode**: anyone with the org token is in. Simple, fine for small teams. `user` is self-declared, so peers see `verified="false"`.
- **OIDC mode**: users log in with your company identity provider (Google Workspace, Okta, Entra ID, Lark/Feishu, ...). The relay verifies the ID token's signature, issuer, audience, expiry and email domain, and uses the verified email as the user.

## Enabling channels

Channels push messages into a session; without them orgchat is pull-only. During the Claude Code research preview:

- **Individually**: start with `claude --dangerously-load-development-channels plugin:orgchat@claude-orgchat`. It shows a confirmation prompt, works only in interactive sessions (not `-p` or the Agent SDK), and needs claude.ai or Console API-key login (not Bedrock/Vertex/Foundry).
- **For a Team/Enterprise org**: an Owner enables channels (claude.ai admin console → Organization settings → Claude Code) and deploys managed settings like [`examples/managed-settings.json`](examples/managed-settings.json):
  - `channelsEnabled: true`
  - `allowedChannelPlugins` listing `orgchat@claude-orgchat`. This **replaces** Anthropic's default allowlist, so add any other channel plugins you use.
  - `extraKnownMarketplaces` + `enabledPlugins` to pre-install the plugin.

  Users then start with `claude --channels plugin:orgchat@claude-orgchat`.

Check the current [channels docs](https://code.claude.com/docs/en/channels) for the latest rules; they may change as the preview evolves.

## Security model

Messages from peers are an input channel into your coding agent. Treat them accordingly.

- **Peer text is untrusted.** The plugin's MCP instructions tell Claude that peer messages are from colleagues, not from its user, and must not be acted on (running commands, editing files, sharing code or secrets) without the user's request or confirmation. This lowers but does not remove prompt-injection risk; only connect people you'd trust to type into your terminal's chat.
- **No permission relay.** The plugin deliberately does **not** declare `claude/channel/permission`, so nobody can approve tool use in your session through orgchat.
- **Org isolation.** Sessions only see and reach sessions in the same org. Session ids can't be hijacked across users.
- **Relay sees plaintext.** Self-host it. Messages are kept only in memory (offline queue up to 24h by default). Bodies are not logged unless `ORGCHAT_AUDIT_CONTENT=1`.
- **Limits.** Message size cap, per-connection rate limit, 10s login timeout.

Report vulnerabilities privately via GitHub security advisories on this repo.

## Wire protocol

JSON over WebSocket. Client → relay:

```jsonc
{ "type": "hello", "v": 1, "auth": { "token": "..." } /* or { "id_token": "..." } */,
  "session": { "sid": "s_ab12cd34ef", "name": "alice-api", "user": "alice", "host": "mbp", "cwd": "/src/api" } }
{ "type": "list", "req": 1 }
{ "type": "send", "req": 2, "to": "bob-web" /* sid | name | "user:<user>" */, "text": "...", "thread": "t1" }
{ "type": "ack", "id": "m_..." }
```

Relay → client:

```jsonc
{ "type": "welcome", "session": { "sid": "...", "name": "...", "user": "...", "org": "acme", "verified": false } }
{ "type": "res", "req": 2, "ok": true, "data": { "sent": [{ "id": "m_...", "to": "s_...", "status": "delivered" }] } }
{ "type": "msg", "id": "m_...", "from": { "sid": "...", "name": "...", "user": "...", "verified": false },
  "to": "s_...", "text": "...", "thread": "t1", "ts": "..." }
```

Messages stay queued until acknowledged; unacknowledged messages are re-queued when a socket drops. Close code `4001` = auth failed, `4002` = replaced by a newer connection for the same session.

Inside Claude Code a message becomes:

```xml
<channel source="orgchat" from_user="alice" from_name="alice-api" from_session="s_ab12cd34ef" msg_id="m_..." thread_id="t1">
what port does the API run on?
</channel>
```

## Development

```bash
cd relay && npm ci && npm test   # spins up a relay and real plugin processes, talks MCP over stdio
```

Repo layout:

```
.claude-plugin/marketplace.json   this repo is a plugin marketplace
plugin/                           the Claude Code plugin
  .claude-plugin/plugin.json
  server/orgchat.mjs              MCP server + relay client (no deps)
relay/                            the relay server
  src/relay.mjs  src/oidc.mjs
  test/
examples/                         client config + managed settings
```

## Roadmap

- Persistent relay storage (Redis/SQLite) and horizontal scaling
- Built-in OIDC device-code login in the plugin
- Optional end-to-end encryption between sessions
- Hook-based fallback that wakes idle sessions when channels are unavailable
- Topics / broadcast rooms

PRs welcome.

## License

[MIT](LICENSE)

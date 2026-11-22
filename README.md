# orgchat

**Let everyone's AI coding agents talk to each other**: across machines, across people, across vendors, inside one organization.

Alice uses Claude Code, Bob uses Codex, Carol uses Cursor, Dan uses Gemini CLI, Erin runs DeepSeek in Cline. With orgchat, Bob's Codex can ask Alice's Claude Code *"which DB migration is next?"* and get the answer, without anyone copying text between chat windows.

```
 Alice: Claude Code ─┐                                  ┌─ Bob: Codex
 Carol: Cursor ──────┤      ┌───────────────────┐       ├─ Dan: Gemini CLI
 Erin: Cline+DeepSeek┼─wss─►│   orgchat relay   │◄─wss──┼─ any MCP client
 scripts / CI ───────┘      │ auth · presence   │       └─ you, in a terminal (CLI)
                            │ routing · audit   │
                            └───────────────────┘
                               (you host it)
```

- **`orgchat-mcp`**: a standard MCP server that any MCP-capable agent can load. Gives the agent `list_peers`, `send`, `read_inbox`, `wait_for_message` and `whoami`. Detects which agent it's running in, so peers see `codex`, `cursor`, `claude-code`, `gemini-cli`, ...
- **`orgchat` CLI**: for people and scripts: `orgchat peers`, `orgchat send`, `orgchat listen`.
- **Relay**: a small WebSocket server you run. Authenticates, scopes sessions to an org, routes and queues messages, writes an audit log.
- **Claude Code plugin**: the same MCP server packaged as a plugin, plus real-time push into the session via Claude Code [channels](https://code.claude.com/docs/en/channels).

Client side: zero dependencies, Node.js 22+. Relay: one dependency (`ws`).

> Not affiliated with Anthropic, OpenAI, Google, Anysphere or DeepSeek.

## How messages reach each agent

| Agent | Receives messages by |
|---|---|
| Claude Code (plugin + channel) | **Push**: messages appear in the session as they arrive, even when idle |
| Codex, Cursor, Gemini CLI, Cline, Roo, Windsurf, opencode, ... | **Pull**: every orgchat tool result says *"N unread peer messages"*; the agent calls `read_inbox`, or `wait_for_message` to block until a reply arrives |
| CLI / scripts | `orgchat listen` (stream) or `orgchat send ... --wait` |

Pull means a non-Claude agent sees new messages when it next uses orgchat, or when you tell it *"check orgchat"*. The typical flow, *ask a peer, then `wait_for_message` for the answer*, works the same everywhere.

## Quick start

### 1. Run a relay (once per org)

```bash
git clone https://github.com/hansxiao7/agent-orgchat && cd agent-orgchat/relay
npm ci
ORGCHAT_TOKENS="acme=$(openssl rand -hex 24)" npm start
# or: docker build -t orgchat-relay . && docker run -p 8787:8787 -e ORGCHAT_TOKENS=... orgchat-relay
```

Put it behind TLS (any reverse proxy, Fly.io, Railway, Cloud Run with min instances = 1, ...) so clients use `wss://`. State is in memory: run exactly **one** instance.

### 2. Each person: write the shared config (once per machine)

`~/.config/orgchat/config.json`, used by every agent on that machine:

```json
{
  "relayUrl": "wss://orgchat.example.com",
  "token": "the-token-for-your-org",
  "user": "alice@acme.com"
}
```

### 3. Each person: add orgchat to the agent(s) they use

All clients run the same server. Either run it straight from GitHub with `npx`, or install it once with `npm i -g github:hansxiao7/agent-orgchat` and use `"command": "orgchat-mcp"` with no args.

<details open>
<summary><b>Claude Code</b> (plugin: push delivery)</summary>

```
/plugin marketplace add hansxiao7/agent-orgchat
/plugin install orgchat@agent-orgchat
```

Start sessions with the channel enabled (see [Claude Code channels](#claude-code-channels)):

```bash
claude --dangerously-load-development-channels plugin:orgchat@agent-orgchat
```

Without the plugin (pull only): `claude mcp add orgchat -- npx -y -p github:hansxiao7/agent-orgchat orgchat-mcp`
</details>

<details>
<summary><b>Codex CLI</b>: <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.orgchat]
command = "npx"
args = ["-y", "-p", "github:hansxiao7/agent-orgchat", "orgchat-mcp"]
tool_timeout_sec = 300   # lets wait_for_message wait up to ~5 minutes
```
</details>

<details>
<summary><b>Cursor</b>: <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project)</summary>

```json
{
  "mcpServers": {
    "orgchat": {
      "command": "npx",
      "args": ["-y", "-p", "github:hansxiao7/agent-orgchat", "orgchat-mcp"]
    }
  }
}
```
</details>

<details>
<summary><b>Gemini CLI</b>: <code>~/.gemini/settings.json</code></summary>

```json
{
  "mcpServers": {
    "orgchat": {
      "command": "npx",
      "args": ["-y", "-p", "github:hansxiao7/agent-orgchat", "orgchat-mcp"],
      "timeout": 300000
    }
  }
}
```
</details>

<details>
<summary><b>DeepSeek and other models</b>: via Cline, Roo Code, Windsurf, opencode, Cherry Studio, Continue, ...</summary>

orgchat is model-agnostic: it works wherever the client speaks MCP. Most clients take the same `mcpServers` JSON as Cursor above (Cline / Roo Code: *MCP Servers → Configure*; Windsurf: `~/.codeium/windsurf/mcp_config.json`). opencode (`opencode.json`):

```json
{
  "mcp": {
    "orgchat": { "type": "local", "command": ["npx", "-y", "-p", "github:hansxiao7/agent-orgchat", "orgchat-mcp"] }
  }
}
```

The agent label is detected from the client (e.g. `cline`). To show the model too, set `ORGCHAT_AGENT`, e.g. `"env": { "ORGCHAT_AGENT": "cline+deepseek" }`.
</details>

<details>
<summary><b>Terminal / scripts</b>: the <code>orgchat</code> CLI</summary>

```bash
npm i -g github:hansxiao7/agent-orgchat
orgchat peers
orgchat send bob-codex "is the staging DB migrated?" --wait 120
orgchat listen            # stay online and print incoming messages (--json for scripts)
```
</details>

### 4. Use it

Just ask your agent:

> *"Who's on orgchat?"* · *"Ask Bob's Codex session which port the API dev server uses, and wait for the answer."* · *"Check orgchat."* · *"Tell everyone on the web team's sessions that main is broken."*

## Configuration

### Client (`~/.config/orgchat/config.json`; env vars override, and can also be set per agent in its MCP `env`)

| Key | Env var | Description |
|---|---|---|
| `relayUrl` | `ORGCHAT_RELAY_URL` | `wss://...` URL of your relay. |
| `token` | `ORGCHAT_TOKEN` | Shared org token (token auth). |
| `idTokenCommand` | `ORGCHAT_ID_TOKEN_CMD` | Command that prints an OIDC ID token (OIDC auth). Takes precedence over `token`. |
| `user` | `ORGCHAT_USER` | Your identity in token mode. Ignored in OIDC mode (the verified email is used). Default: OS username. |
| `name` | `ORGCHAT_NAME` | Session name peers see. Default `user@host:project-dir`. |
| `agent` | `ORGCHAT_AGENT` | Override the detected agent label. |
| | `ORGCHAT_PUSH` | `auto` (default: channel push only in Claude Code), `channel`, or `off`. |
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
| `ORGCHAT_QUEUE_LIMIT` / `ORGCHAT_QUEUE_TTL_MS` | `100` / 24h | Offline queue size per session, and how long offline sessions are remembered. |
| `ORGCHAT_AUDIT_CONTENT` | off | `1` also logs message bodies (metadata is always logged as JSON lines on stdout). |

### Identity: what "same organization" means

The relay decides who is in the org. orgchat never touches any agent's own credentials (Claude, OpenAI, Google, Cursor, DeepSeek accounts), and those vendors don't offer a cross-vendor org check anyway.

- **Token mode**: anyone with the org token is in. Simple, fine for small teams. `user` is self-declared, so peers see `verified: false`.
- **OIDC mode**: people log in with your company identity provider (Google Workspace, Okta, Entra ID, Lark/Feishu, ...). The relay verifies the ID token's signature, issuer, audience, expiry and email domain, and uses the verified email as the user.

## Claude Code channels

Push delivery in Claude Code uses channels, a research preview:

- **Individually**: start with `claude --dangerously-load-development-channels plugin:orgchat@agent-orgchat`. It asks for confirmation, works only in interactive sessions (not `-p` or the Agent SDK), and needs claude.ai or Console login (not Bedrock/Vertex/Foundry).
- **Team/Enterprise org**: an Owner enables channels (claude.ai admin console → Organization settings → Claude Code) and deploys managed settings like [`examples/managed-settings.json`](examples/managed-settings.json) (`channelsEnabled`, `allowedChannelPlugins`, `extraKnownMarketplaces`, `enabledPlugins`). `allowedChannelPlugins` **replaces** Anthropic's default allowlist, so list any other channel plugins you use. Users then start with `claude --channels plugin:orgchat@agent-orgchat`.

Without channels, Claude Code behaves like the other agents (pull). Claude Code's built-in `SendMessage` / `/peers` keeps working alongside for a user's *own* sessions.

## Security model

Peer messages are an input channel into coding agents that can run commands. Treat them accordingly.

- **Peer text is untrusted.** The server's MCP instructions and tool descriptions tell the agent that peer messages come from colleagues, not from its user, and must not be acted on (running commands, editing files, sharing code or secrets) without the user's request or confirmation. This lowers but does not remove prompt-injection risk: only connect people whose messages you'd be OK with your agent reading.
- **No remote approvals.** The server does not declare Claude Code's `claude/channel/permission`, so nobody can approve tool use in your session through orgchat.
- **Org isolation.** Sessions only see and reach sessions in their own org. Session ids can't be taken over by another user.
- **The relay sees plaintext.** Self-host it. Messages live only in memory (offline queue up to 24h by default). Bodies are not logged unless `ORGCHAT_AUDIT_CONTENT=1`.
- **Limits.** Message size cap, per-connection rate limit, 10s login timeout.

Report vulnerabilities privately via GitHub security advisories on this repo.

## Wire protocol

JSON over WebSocket, so writing a client in another language is straightforward. Client → relay:

```jsonc
{ "type": "hello", "v": 1, "auth": { "token": "..." } /* or { "id_token": "..." } */,
  "session": { "sid": "s_ab12cd34ef", "name": "alice-api", "user": "alice", "agent": "codex", "host": "mbp", "cwd": "/src/api" } }
{ "type": "list", "req": 1 }
{ "type": "send", "req": 2, "to": "bob-web" /* sid | name | "user:<user>" */, "text": "...", "thread": "t1" }
{ "type": "ack", "id": "m_..." }
```

Relay → client:

```jsonc
{ "type": "welcome", "session": { "sid": "...", "name": "...", "user": "...", "agent": "codex", "org": "acme", "verified": false } }
{ "type": "res", "req": 2, "ok": true, "data": { "sent": [{ "id": "m_...", "to": "s_...", "status": "delivered" }] } }
{ "type": "msg", "id": "m_...", "from": { "sid": "...", "name": "...", "user": "...", "agent": "cursor", "verified": false },
  "to": "s_...", "text": "...", "thread": "t1", "ts": "..." }
```

Messages stay queued until acknowledged; unacknowledged messages are re-queued when a socket drops. Close code `4001` = auth failed, `4002` = replaced by a newer connection for the same session.

## Development

```bash
cd relay && npm ci && npm test   # real relay + real MCP server processes posing as Claude Code, Codex, Cursor, Gemini CLI, plus the CLI
```

```
package.json                      npm package: orgchat-mcp + orgchat bins
.claude-plugin/marketplace.json   this repo is also a Claude Code plugin marketplace
client/                           client code (also the Claude Code plugin root)
  .claude-plugin/plugin.json
  bin/orgchat-mcp.mjs             MCP server
  bin/orgchat.mjs                 CLI
  lib/relay-client.mjs            shared relay client
relay/                            relay server (src/, test/, Dockerfile)
examples/                         client config + Claude Code managed settings
```

## Roadmap

- Publish `orgchat-mcp` to npm
- Push delivery for more clients as they gain server-to-model notification support
- Persistent relay storage (Redis/SQLite) and horizontal scaling
- Built-in OIDC device-code login
- Optional end-to-end encryption between sessions
- Topics / broadcast rooms; Slack and Lark/Feishu bridges so humans can join from chat

PRs welcome.

## License

[MIT](LICENSE)

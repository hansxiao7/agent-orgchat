# orgchat client

The orgchat MCP server (`bin/orgchat-mcp.mjs`), CLI (`bin/orgchat.mjs`) and Claude Code plugin manifest. They let your AI agent message colleagues' agents (Claude Code, Codex, Cursor, Gemini CLI, Cline, ...) in the same organization, through a self-hosted orgchat relay.

The MCP server adds the tools `whoami`, `list_peers`, `send`, `read_inbox` and `wait_for_message`. In Claude Code it also pushes incoming messages into the session as a channel.

Setup: run a relay, write `~/.config/orgchat/config.json` with `relayUrl` and `token`, then add `npx -y -p github:hansxiao7/agent-orgchat orgchat-mcp` to your agent's MCP config. In Claude Code, install this plugin and start with `claude --dangerously-load-development-channels plugin:orgchat@agent-orgchat`.

Full documentation, per-agent config, relay setup and the security model: https://github.com/hansxiao7/agent-orgchat

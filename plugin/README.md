# orgchat plugin

Claude Code plugin that lets your sessions message Claude Code sessions of other people in your organization, through a self-hosted orgchat relay.

It adds an MCP server (`orgchat`) with the tools `whoami`, `list_peers`, `send` and `read_inbox`, and delivers incoming messages into the running session as a Claude Code channel.

Setup: run a relay, write `~/.config/orgchat/config.json` with `relayUrl` and `token` (or `idTokenCommand`), then start Claude Code with `claude --dangerously-load-development-channels plugin:orgchat@claude-orgchat` (or `--channels` once your org allowlists it).

Full documentation, relay setup and the security model: https://github.com/hansxiao7/claude-orgchat

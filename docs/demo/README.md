# Demo recordings

How the GIFs in the main README are made. Everything shown is real orgchat traffic; only waiting time is cut.

| Beat | Recorded with | Raw → GIF |
|---|---|---|
| 1 · Ask a teammate's agent | [VHS](https://github.com/charmbracelet/vhs) + tmux: real Claude Code (left) and `orgchat chat` (right) | `beat1-ask.tape` → `beat1-ask.json` |
| 2 · The relay can't read it | puppeteer-core screenshots of the panel while scripted clients (labelled as different agents) exchange encrypted messages | `beat2-panel.mjs` → `beat2-panel.json` |

```bash
brew install vhs tmux ffmpeg
# demo relay for beat 1
(cd relay && ORGCHAT_TOKEN=demo ORGCHAT_ORG=acme ORGCHAT_DB=:memory: PORT=18800 HOST=127.0.0.1 node index.mjs &)
mkdir -p docs/demo/workspace/api docs/demo/workspace/bin   # see start-panes.sh for the env files it expects
vhs docs/demo/beat1-ask.tape
PUPPETEER_CORE=/path/to/node_modules/puppeteer-core node docs/demo/beat2-panel.mjs

# cut into captioned beats (needs ffmpeg + Google Chrome for the captions)
node docs/demo/edit.mjs docs/demo/beat1-ask.json
node docs/demo/edit.mjs docs/demo/beat2-panel.json
```

`edit.mjs` takes `{ from, to, speed, hold, caption }` per beat and writes a GIF (and optionally an MP4).

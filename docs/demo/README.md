# Demo recordings

How the media in the main README is made. The Claude Code session is real (waiting is cut, one stretch sped up 2.5x); the admin panel runs on demo data; the IM chat in the video is an illustration.

## Launch video (`docs/media/orgchat-launch.mp4`)

`video/` is a tiny deterministic motion-graphics renderer: `scenes.js` draws every frame as a pure function of time, `render.mjs` steps through it with puppeteer and screenshots each frame, `soundtrack.mjs` synthesizes the 120 BPM music and sound effects from the scene cues (nothing to license), and ffmpeg muxes it all, loudness-normalized to -14 LUFS.

```bash
brew install vhs tmux ffmpeg
# 1. raw recordings
(cd relay && ORGCHAT_TOKEN=demo ORGCHAT_ORG=acme ORGCHAT_DB=:memory: PORT=18800 HOST=127.0.0.1 node index.mjs &)
vhs docs/demo/beat1-ask.tape                       # real Claude Code + orgchat chat, side by side (see start-panes.sh)
PUPPETEER_CORE=/path/to/puppeteer-core node docs/demo/beat2-panel.mjs
# 2. the video (about a minute)
PUPPETEER_CORE=/path/to/puppeteer-core node docs/demo/video/render.mjs            # -> docs/demo/out/orgchat-launch.mp4
PUPPETEER_CORE=/path/to/puppeteer-core node docs/demo/video/render.mjs --stills 3,10,25   # a few frames to check
```

`start-panes.sh` expects `docs/demo/workspace/{alice,bob,common}.env` and a `bin/orgchat` wrapper (gitignored).

## Panel GIF (`docs/media/beat2-panel.gif`)

`edit.mjs` cuts a raw recording into captioned beats: `node docs/demo/edit.mjs docs/demo/beat2-panel.json`.

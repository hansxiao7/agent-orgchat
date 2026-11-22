# Beat 1: a Claude Code session asks a teammate's session; the answer comes back end-to-end encrypted.
# Run from the repo root with a demo relay on :18800 (see docs/demo/README.md):  vhs docs/demo/beat1-ask.tape
Output docs/demo/out/beat1-ask.mp4
Require tmux
Require claude
Set Shell bash
Set FontSize 15
Set Width 1440
Set Height 720
Set Padding 16
Set Theme "Builtin Dark"
Set TypingSpeed 35ms

Hide
Type "clear; docs/demo/start-panes.sh" Enter
Sleep 5s
# first run only: accept the folder-trust prompt (harmless afterwards)
Down
Enter
Sleep 8s
Ctrl+L
Show

Type "Ask bob-web which port the API dev server needs. Wait for the reply, then answer me in one line."
Sleep 500ms
Enter
Sleep 25s

Ctrl+B
Type "o"
Sleep 300ms
Type "8080, and export REDIS_URL first"
Enter
Sleep 25s

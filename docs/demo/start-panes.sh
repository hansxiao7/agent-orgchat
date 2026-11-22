#!/bin/bash
# Two panes for the demo recordings: left = Alice's Claude Code, right = Bob's terminal (orgchat chat).
D=$(cd "$(dirname "$0")" && pwd)
T="tmux -L orgchat-demo -f $D/tmux.conf"
TOOLS=mcp__plugin_orgchat_orgchat__send,mcp__plugin_orgchat_orgchat__wait_for_message,mcp__plugin_orgchat_orgchat__list_peers,mcp__plugin_orgchat_orgchat__read_inbox
$T kill-server 2>/dev/null
$T new-session -d -s demo -x "${COLS:-170}" -y "${ROWS:-40}" -c "$D/workspace/api" "bash --norc"
$T split-window -h -l 43% -t demo -c "$D/workspace" "bash --norc"
$T send-keys -t demo:0.1 ". ./bob.env; PS1='$ '; clear; orgchat chat" Enter
$T send-keys -t demo:0.0 ". ../alice.env; PS1='$ '; clear; claude --plugin-dir $D/../../client --allowedTools $TOOLS" Enter
$T select-pane -t demo:0.0
exec $T attach -t demo

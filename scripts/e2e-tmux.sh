#!/usr/bin/env bash
# Run an e2e drive inside tmux so it can be watched from anywhere.
#
# The WORKER transport is unaffected (headless stays headless) — this only puts
# the driver daemon and a live status pane in a tmux session, so a human can
# attach read-only from another terminal and see the drive without being able to
# type into it.
#
#   scripts/e2e-tmux.sh --copilot-models        # start (any `start` flags pass through)
#   tmux attach -t maestro-e2e -r               # watch, read-only
#   scripts/e2e-tmux.sh --kill                  # stop the session
#
# Read-only matters: an accidental keystroke in the daemon pane would otherwise
# reach the driver's stdin.

set -euo pipefail

SESSION="${PI_E2E_TMUX_SESSION:-maestro-e2e}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JITI="node_modules/.bin/jiti"
CLI="test/e2e/driver/cli.ts"

if [[ "${1:-}" == "--kill" ]]; then
	tmux kill-session -t "$SESSION" 2>/dev/null && echo "killed $SESSION" || echo "no session $SESSION"
	exit 0
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
	echo "session $SESSION already exists — attach with: tmux attach -t $SESSION -r" >&2
	exit 1
fi

cd "$ROOT"

# Pane 1: the daemon itself (its ready line carries repoDir/piHome).
tmux new-session -d -s "$SESSION" -n drive \
	"$JITI $CLI start $* 2>&1 | tee /tmp/$SESSION-daemon.log; echo; echo '[daemon exited — pane held open]'; exec sleep infinity"

# Pane 2: the narration — what the maestro is actually thinking and doing.
# This is the pane worth watching; the daemon's own output is one JSON line.
tmux split-window -t "$SESSION:drive" -v \
	"while [ ! -s /tmp/$SESSION-daemon.log ] || ! grep -q '\"piHome\"' /tmp/$SESSION-daemon.log; do sleep 2; done
	 home=\$(grep -o '\"piHome\":\"[^\"]*\"' /tmp/$SESSION-daemon.log | tail -1 | cut -d'\"' -f4)
	 exec node scripts/e2e-narrate.mjs \"\$home\""

# Pane 3: live plan status, refreshed every 10s. Reads the ledger directly
# rather than the control socket so it keeps working if the daemon is busy.
tmux split-window -t "$SESSION:drive" -v \
	"while true; do
		clear
		echo \"== pi-maestro e2e — \$(date +%H:%M:%S) ==\"
		home=\$(grep -o '\"piHome\":\"[^\"]*\"' /tmp/$SESSION-daemon.log 2>/dev/null | tail -1 | cut -d'\"' -f4)
		if [ -z \"\$home\" ]; then echo 'waiting for the daemon to report ready…'; else
			plan=\$(find \"\$home\" -name plan.json 2>/dev/null | head -1)
			if [ -z \"\$plan\" ]; then echo 'no plan authored yet'; else
				python3 - \"\$plan\" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print('plan:', d.get('title','?')[:70])
print()
for n in d.get('nodes',[]):
    line=f\"  {n.get('status','?'):<10} {n.get('title','?')[:34]:<36}\"
    if n.get('branch'): line+=f\" {n['branch'][:26]:<28}\"
    if n.get('prUrl'): line+=' PR'
    print(line)
    if n.get('blocked'): print(f\"      BLOCKED: {n['blocked'][:100]}\")
PY
			fi
		fi
		sleep 10
	done"

# Narration gets the room; the daemon and status panes just need a few lines.
tmux select-layout -t "$SESSION:drive" main-horizontal
tmux resize-pane -t "$SESSION:drive.0" -y 6 2>/dev/null || true
tmux resize-pane -t "$SESSION:drive.2" -y 10 2>/dev/null || true

cat <<EOF
started tmux session: $SESSION

  watch (read-only):  tmux attach -t $SESSION -r
  stop the drive:     scripts/e2e-tmux.sh --kill

Panes: daemon (small, top) · live narration of the maestro's reasoning and
tool calls (main) · plan status refreshed every 10s (bottom).

Do NOT kill panes to stop it — that leaves the drive half-dead. Use --kill.
EOF

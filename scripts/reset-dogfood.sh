#!/usr/bin/env bash
#
# Reset the dogfood environment for a clean pi-maestro run:
#   1. wipe the isolated dogfood profile's plans + sessions, and
#   2. reset the maestro sandbox repos back to their `baseline` tag.
#
# Plans live under the dogfood profile (only pi-maestro knows where), so the
# sandbox repo's own reset can't clear them — that's why this entry point lives
# here. The git-side reset is delegated to the sandbox repo's reset.sh so the
# baseline logic stays in one place.
#
# Usage:
#   scripts/reset-dogfood.sh [--yes] [--remote] [--restore-dev]
#                            [--plans-only] [--repo <name>]
#
#   (no flags)      Dry-run: print what would happen, change nothing.
#   --yes           Apply: wipe plans/sessions + local sandbox reset.
#   --remote        Also close open PRs and delete remote feat/* (sandbox).
#   --restore-dev   Force-push sandbox dev -> baseline on origin. Implies
#                   --remote.
#   --plans-only    Only wipe dogfood plans/sessions; skip the sandbox repos.
#   --repo <name>   Scope the sandbox reset to one repo (lib | service | docs).
#
set -euo pipefail

DOGFOOD_ROOT="${DOGFOOD_ROOT:-$HOME/.pi-maestro-dogfood}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_RESET="$ROOT/../maestro-sandbox-lib/scripts/reset.sh"

APPLY=0
PLANS_ONLY=0
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
	case "$1" in
		--yes) APPLY=1 ;;
		--plans-only) PLANS_ONLY=1 ;;
		--remote | --restore-dev) PASSTHROUGH+=("$1") ;;
		--repo)
			PASSTHROUGH+=("$1" "${2:-}")
			shift
			;;
		-h | --help)
			sed -n '2,28p' "$0"
			exit 0
			;;
		*)
			echo "unknown argument: $1" >&2
			exit 2
			;;
	esac
	shift
done

say() { printf '%s\n' "$*"; }
run() {
	if [[ "$APPLY" -eq 1 ]]; then
		"$@"
	else
		say "  [dry-run] $*"
	fi
}

if [[ "$APPLY" -eq 0 ]]; then
	say "DRY RUN — pass --yes to apply. Nothing will be changed."
fi

say ""
say "=== dogfood profile: $DOGFOOD_ROOT ==="
plans_dir="$DOGFOOD_ROOT/agent/maestro/plans"
sessions_dir="$DOGFOOD_ROOT/sessions"
if [[ -d "$plans_dir" ]]; then
	for p in "$plans_dir"/*/; do
		[[ -e "$p" ]] || continue
		say "  plan: $(basename "$p")"
	done
	run rm -rf "$plans_dir"
else
	say "  no plans to wipe"
fi
if [[ -d "$sessions_dir" ]]; then
	run rm -rf "$sessions_dir"
	run mkdir -p "$sessions_dir"
fi

if [[ "$PLANS_ONLY" -eq 1 ]]; then
	say ""
	say "done (plans only)."
	exit 0
fi

say ""
say "=== sandbox repos ==="
if [[ ! -x "$SANDBOX_RESET" && ! -f "$SANDBOX_RESET" ]]; then
	say "  sandbox reset script not found: $SANDBOX_RESET" >&2
	say "  (clone maestro-sandbox-lib as a sibling of this repo)" >&2
	exit 1
fi

sandbox_args=()
[[ "$APPLY" -eq 1 ]] && sandbox_args+=("--yes")
for a in "${PASSTHROUGH[@]:-}"; do [[ -n "$a" ]] && sandbox_args+=("$a"); done

if [[ ${#sandbox_args[@]} -gt 0 ]]; then
	bash "$SANDBOX_RESET" "${sandbox_args[@]}"
else
	bash "$SANDBOX_RESET"
fi

say ""
say "done."

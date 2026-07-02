SHELL := /bin/bash

PI ?= pi
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DOGFOOD_ROOT ?= $(HOME)/.pi-maestro-dogfood
SANDBOX_REPO ?= lib
SANDBOX ?= $(abspath $(ROOT)/../maestro-sandbox-$(SANDBOX_REPO))
DOGFOOD_FLAGS := \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-themes \
	--no-context-files \
	--no-approve

.PHONY: help dogfood dogfood-fresh dogfood-sandbox reset reset-yes reset-remote reset-plans check test-ask

RESET := $(ROOT)/scripts/reset-dogfood.sh

help:
	@printf "Targets:\n"
	@printf "  make dogfood       Run pi-maestro isolated from normal pi config\n"
	@printf "  make dogfood-fresh Run pi-maestro with a throwaway temp profile\n"
	@printf "  make dogfood-sandbox  Run pi-maestro against a maestro-sandbox-* repo\n"
	@printf "  make dogfood-plan    Reset + start with plan prompt (just /auto after)\n"
	@printf "  make reset         Dry-run: wipe dogfood plans + reset sandbox repos\n"
	@printf "  make reset-yes     Apply: wipe plans/sessions + local sandbox reset\n"
	@printf "  make reset-remote  reset-yes + close PRs + delete remote feat/*\n"
	@printf "  make reset-plans   Wipe only the dogfood plans/sessions\n"
	@printf "  make check         Run repo validation\n"
	@printf "\nVariables:\n"
	@printf "  PI=%s\n" "$(PI)"
	@printf "  DOGFOOD_ROOT=%s\n" "$(DOGFOOD_ROOT)"
	@printf "  SANDBOX_REPO=%s (lib|service|docs)\n" "$(SANDBOX_REPO)"
	@printf "  SANDBOX=%s\n" "$(SANDBOX)"

# Isolated from the normal ~/.pi/agent profile, but reusable so provider auth
# and dogfood-only settings survive across runs.
dogfood:
	@mkdir -p "$(DOGFOOD_ROOT)/agent" "$(DOGFOOD_ROOT)/sessions"
	@printf "Using isolated dogfood profile: %s\n" "$(DOGFOOD_ROOT)"
	PI_CODING_AGENT_DIR="$(DOGFOOD_ROOT)/agent" \
	PI_CODING_AGENT_SESSION_DIR="$(DOGFOOD_ROOT)/sessions" \
	"$(PI)" $(DOGFOOD_FLAGS) -e "$(ROOT)"

# Fully clean one-off run. This intentionally does not persist provider auth.
dogfood-fresh:
	@tmp="$$(mktemp -d)"; \
	printf "Using throwaway dogfood profile: %s\n" "$$tmp"; \
	PI_CODING_AGENT_DIR="$$tmp/agent" \
	PI_CODING_AGENT_SESSION_DIR="$$tmp/sessions" \
	"$(PI)" $(DOGFOOD_FLAGS) -e "$(ROOT)"

# Run the isolated dogfood profile with the session cwd set to a sandbox repo
# (maestro-sandbox-lib by default), so plans/worktrees/PRs target the sandbox
# while pi-maestro is loaded from this repo. Switch repos with SANDBOX_REPO.
dogfood-sandbox:
	@if [ ! -d "$(SANDBOX)" ]; then \
		printf "sandbox repo not found: %s\n" "$(SANDBOX)" >&2; \
		printf "set SANDBOX_REPO=lib|service|docs or SANDBOX=<path>\n" >&2; \
		exit 1; \
	fi
	@mkdir -p "$(DOGFOOD_ROOT)/agent" "$(DOGFOOD_ROOT)/sessions"
	@printf "Dogfooding pi-maestro against: %s\n" "$(SANDBOX)"
	cd "$(SANDBOX)" && \
	PI_CODING_AGENT_DIR="$(DOGFOOD_ROOT)/agent" \
	PI_CODING_AGENT_SESSION_DIR="$(DOGFOOD_ROOT)/sessions" \
	"$(PI)" $(DOGFOOD_FLAGS) -e "$(ROOT)"

dogfood-plan:
	@$(MAKE) reset-remote
	@if [ ! -d "$(SANDBOX)" ]; then \
		printf "sandbox repo not found: %s\n" "$(SANDBOX)" >&2; \
		exit 1; \
	fi
	@mkdir -p "$(DOGFOOD_ROOT)/agent" "$(DOGFOOD_ROOT)/sessions"
	@printf "Reset done. Starting pi with plan prompt...\n"
	cd "$(SANDBOX)" && \
	PI_CODING_AGENT_DIR="$(DOGFOOD_ROOT)/agent" \
	PI_CODING_AGENT_SESSION_DIR="$(DOGFOOD_ROOT)/sessions" \
	"$(PI)" $(DOGFOOD_FLAGS) -e "$(ROOT)" @$(ROOT)/dogfood-prompt.md

check:
	npm run check

# Present a synthetic questionnaire exercising all dialog features (no LLM).
test-ask:
	"$(PI)" $(DOGFOOD_FLAGS) -e "$(ROOT)" -e "$(ROOT)/scripts/test-ask-harness.ts" --no-session

# Reset the dogfood environment: wipe the isolated profile's plans/sessions and
# reset the sandbox repos to baseline. Plans live in the dogfood profile, so the
# sandbox repo's own reset can't clear them — this target owns that.
reset:
	@DOGFOOD_ROOT="$(DOGFOOD_ROOT)" "$(RESET)"

reset-yes:
	@DOGFOOD_ROOT="$(DOGFOOD_ROOT)" "$(RESET)" --yes

reset-remote:
	@DOGFOOD_ROOT="$(DOGFOOD_ROOT)" "$(RESET)" --yes --remote

reset-plans:
	@DOGFOOD_ROOT="$(DOGFOOD_ROOT)" "$(RESET)" --yes --plans-only

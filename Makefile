SHELL := /bin/bash

PI ?= pi
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DOGFOOD_ROOT ?= $(HOME)/.pi-maestro-dogfood
DOGFOOD_FLAGS := \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-themes \
	--no-context-files \
	--no-approve

.PHONY: help dogfood dogfood-fresh check

help:
	@printf "Targets:\n"
	@printf "  make dogfood       Run pi-maestro isolated from normal pi config\n"
	@printf "  make dogfood-fresh Run pi-maestro with a throwaway temp profile\n"
	@printf "  make check         Run repo validation\n"
	@printf "\nVariables:\n"
	@printf "  PI=%s\n" "$(PI)"
	@printf "  DOGFOOD_ROOT=%s\n" "$(DOGFOOD_ROOT)"

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

check:
	npm run check

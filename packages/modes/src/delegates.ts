// Unified delegate spawning. All delegates (explorer, researcher, advisor)
// spawn via tmux+RPC, same as execution agents. This module defines the
// delegate target configs and spawning logic.

import type { ModelSlot, ThinkingLevel } from "@vegardx/pi-contracts";

/**
 * Delegate target configuration.
 * Defines the behavior and constraints for each delegate type.
 */
export interface DelegateTarget {
	/** Target name used in delegate(to=...) calls. */
	name: string;
	/** Model slot to use. */
	slot: ModelSlot;
	/** Thinking effort level. */
	effort: ThinkingLevel;
	/** Tools available to this delegate. */
	tools: readonly string[];
	/** Whether plan context is injected into the seed. */
	injectPlanContext: boolean;
	/** System prompt prefix for the delegate. */
	systemPrefix: string;
}

/** Built-in delegate targets. */
export const DELEGATE_TARGETS: Record<string, DelegateTarget> = {
	explorer: {
		name: "explorer",
		slot: "default",
		effort: "low",
		tools: ["read", "bash", "find", "grep", "ls"],
		injectPlanContext: false,
		systemPrefix:
			"You are a codebase explorer. Find facts and answer questions about the codebase. " +
			"Be precise and concise. Report file paths, line numbers, type signatures, and " +
			"relevant code snippets. Do not speculate — only report what you find.",
	},
	researcher: {
		name: "researcher",
		slot: "default",
		effort: "low",
		tools: ["websearch", "webfetch", "read"],
		injectPlanContext: false,
		systemPrefix:
			"You are a web researcher. Find documentation, examples, and best practices. " +
			"Be precise and cite sources. Report relevant API signatures, configuration " +
			"options, and usage patterns. Do not speculate beyond what documentation shows.",
	},
	advisor: {
		name: "advisor",
		slot: "alternate",
		effort: "high",
		tools: ["read", "bash", "find", "grep", "ls"],
		injectPlanContext: true,
		systemPrefix:
			"You are a senior engineering advisor reviewing a plan. You use a different model " +
			"family than the planner — bring fresh perspective. Challenge assumptions, identify " +
			"gaps, suggest alternatives. Be constructive and specific. If the plan looks good, " +
			"say so briefly and explain why.",
	},
};

/**
 * Build the seed for a delegate agent.
 * The seed is the initial prompt that the delegate works from.
 */
export function buildDelegateSeed(
	target: DelegateTarget,
	message: string,
	planContext?: string,
): string {
	const parts: string[] = [target.systemPrefix, "", "## Task", "", message];

	if (target.injectPlanContext && planContext) {
		parts.push("", "## Current Plan Context", "", planContext);
	}

	return parts.join("\n");
}

/**
 * Extract a delegate result from the agent's final output.
 * Delegates return their answer as the last message content.
 */
export function extractDelegateResult(output: string): string {
	// Strip any trailing tool call artifacts or metadata
	return output.trim();
}

/**
 * Resolve a delegate target by name.
 * Returns undefined for unknown targets.
 */
export function resolveTarget(name: string): DelegateTarget | undefined {
	return DELEGATE_TARGETS[name];
}

/**
 * List available delegate targets (for help/error messages).
 */
export function availableTargets(): string[] {
	return Object.keys(DELEGATE_TARGETS);
}

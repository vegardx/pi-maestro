// The plan→execution seed: when the maestro crosses from plan into auto/hack,
// the gate forks a FRESH execution session (clean of the whole planning
// conversation) and this seed carries forward the essentials — the decisions,
// their rationale, and a short statement of what we're building. The plan's
// deliverables/tasks are NOT seeded: plan.json is harness state, loaded live.
//
// RPC-safe by construction: the seed is a plan-dir document whose path rides
// modes state; the execution preamble injects it as a system-prompt block
// (executionSeedPromptBlock) — the same mechanism the /handoff seed uses. It
// never depends on newSession's setup/withSession callbacks (absent over RPC)
// or on delivering a message across the session switch.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runAgentTurn } from "@vegardx/pi-core";
import { type PlanV2, walkNodes } from "../plan/schema.js";
import type { RuntimeContext } from "./context.js";

/**
 * Bound on the seed-summary turn — a short single-shot distill in the plan
 * session before the fork. Well under the drive's stall threshold; on timeout
 * the mechanical fallback stands in so a transition never wedges on it.
 */
export const TRANSITION_SEED_TIMEOUT_MS = 60_000;

const SEED_PROMPT =
	"[Forming the execution handoff — you are about to fork a FRESH session to " +
	"conduct this plan, clean of this planning conversation. Write the seed that " +
	"carries forward. Reply with ONLY the seed, no preamble:\n" +
	"1. **What we're building** — two or three sentences.\n" +
	"2. **Decisions & rationale** — the choices we made and WHY (the trade-offs " +
	"we resolved, the paths we rejected). Bullet points.\n" +
	"3. **Watch-outs** — anything the execution conductor should keep in mind " +
	"(constraints, sequencing, risks), if any.\n" +
	"Do NOT restate the deliverables or tasks — the plan itself is carried " +
	"separately. Be concise; this is context, not a document.]";

/**
 * The mechanical fallback seed — used when the model turn is unavailable, times
 * out, or returns nothing. It cannot recover the conversational rationale, so
 * it points at what IS durable: the plan and its understanding.
 */
export function mechanicalTransitionSeed(plan: PlanV2): string {
	const lines = [`We are executing plan \`${plan.slug}\` — ${plan.title}.`];
	if (plan.understanding) lines.push("", plan.understanding);
	lines.push(
		"",
		"(The seed summariser was unavailable — the decisions and rationale live " +
			"in the planning session this was forked from; the full plan structure " +
			"is loaded from plan.json.)",
	);
	return lines.join("\n");
}

/** Wrap the seed body as the execution-seed document. */
export function formatTransitionSeedDoc(plan: PlanV2, body: string): string {
	return (
		`# Execution seed — plan \`${plan.slug}\`\n\n` +
		"Forked into a fresh execution session from the planning conversation. " +
		"This is the carried context — decisions, rationale, what we're building. " +
		"The plan's deliverables and tasks are loaded from plan.json, not here.\n\n" +
		body.trim()
	);
}

/**
 * Build the seed: one bounded self-curated turn in the plan session, falling
 * back to the mechanical seed. Runs BEFORE the fork so it has the full planning
 * context.
 */
export async function buildTransitionSeed(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	plan: PlanV2,
): Promise<string> {
	try {
		const reply = await runAgentTurn(pi, ctx, SEED_PROMPT, {
			timeoutMs: TRANSITION_SEED_TIMEOUT_MS,
		});
		const body = reply.trim();
		if (body.length > 0) return formatTransitionSeedDoc(plan, body);
	} catch {
		// Unavailable model, refusal, timeout — fall back to the mechanical seed.
	}
	return formatTransitionSeedDoc(plan, mechanicalTransitionSeed(plan));
}

/** Persist under <planDir>/transitions/NN-execution.md; numbering continues on disk. */
export function writeTransitionSeed(planDir: string, content: string): string {
	const dir = join(planDir, "transitions");
	mkdirSync(dir, { recursive: true });
	let max = 0;
	if (existsSync(dir)) {
		for (const file of readdirSync(dir)) {
			const match = file.match(/^(\d+)-/);
			if (match) max = Math.max(max, Number.parseInt(match[1], 10));
		}
	}
	const path = join(dir, `${String(max + 1).padStart(2, "0")}-execution.md`);
	writeFileSync(path, content, "utf8");
	return path;
}

/**
 * The follow-up note delivered into the restored plan session on a backward
 * auto/hack→plan return: what executed while the user was in execution, so the
 * planning context reorients rather than resuming cold. Pure/testable.
 */
export function backToPlanNote(plan: PlanV2 | undefined): string {
	if (!plan) {
		return "[Returned to plan mode. Continue planning, or /handoff to close the arc.]";
	}
	const counts: Record<string, number> = {};
	for (const { node } of walkNodes(plan)) {
		counts[node.status] = (counts[node.status] ?? 0) + 1;
	}
	const order = ["shipped", "complete", "active", "failed", "planned"];
	const parts = order
		.filter((status) => counts[status])
		.map((status) => `${counts[status]} ${status}`);
	const summary = parts.length ? parts.join(", ") : "no node status changes";
	return (
		`[Returned to plan mode from execution. Node status now: ${summary}. ` +
		`The plan \`${plan.slug}\` is loaded — you can extend it (new deliverables ` +
		"activate when you return to execution) or answer new questions. Do not " +
		"restart shipped or active work.]"
	);
}

/**
 * The execution-seed system-prompt block, appended to the auto/hack preamble
 * while a seed is set. Rides every execution turn (cache-stable, constant per
 * arc) so the conductor keeps the planning rationale in view without the
 * planning conversation. Retires when the state field is cleared (backward
 * return to plan).
 */
export function executionSeedPromptBlock(
	rt: RuntimeContext,
): string | undefined {
	const path = rt.state.executionSeedPath;
	if (!path) return undefined;
	try {
		const doc = readFileSync(path, "utf8");
		return `## Execution seed (carried from planning — decisions & rationale)\n${doc}`;
	} catch {
		return undefined;
	}
}

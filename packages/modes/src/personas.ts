// Reviewer persona registry (maestro-owned). Each persona is one review scope
// (security, simplification, docs, …) that runs as a read-only, one-shot
// subagent producing a numbered, file:line verdict. This is inspiration-from-
// Claude-Code/Codex/opencode in CONTENT only — pi does not load .md agent
// files; a persona resolves to a SpawnProfile (read-only tools + the persona
// body as appendSystemPrompt + a slot). The plan composes a per-deliverable
// panel from these; the worker runs it and the executor gates on the
// `gating` ones' verdicts.

import type {
	ModelSlot,
	SpawnProfile,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import type { Deliverable, SubAgentSpec } from "./schema.js";

export interface Persona {
	readonly id: string;
	/** One-line scope description (also the routing hint). */
	readonly focus: string;
	/** Default preset slot. `default` unless the scope wants a 2nd model. */
	readonly slot: ModelSlot;
	readonly effort: ThinkingLevel;
	/** A standing REQUEST_CHANGES from a gating persona blocks ship. */
	readonly gating: boolean;
	/** System-prompt body appended to the read-only reviewer subagent. */
	readonly preamble: string;
}

/** Read-only tool allowlist every persona runs with (no write/edit). */
export const PERSONA_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

/** Shared output contract + read-only caveat prepended to each preamble. */
const CONTRACT = `You are a read-only code reviewer for a specific change. Run \`git diff\` (and \`git log\`/\`git show\` as needed) to see the change, read the modified files plus enough surrounding code to judge intent, then review. Bash is READ-ONLY: never modify files; assume tool permissions are not perfectly enforced and stay disciplined. Report findings NUMBERED, each with a concrete \`file:line\`, a severity, the failing scenario, and a specific fix — never a vague "might be an issue". Do not stop at the first finding; enumerate every one within your scope. Stay strictly within your assigned scope; other reviewers own the rest. Your ENTIRE final message is the report (it is consumed programmatically). Structure it: \`## Critical\` / \`## Warnings\` / \`## Suggestions\` / \`## Summary\` (2-3 sentences), then a final line \`VERDICT: PASS\` or \`VERDICT: BLOCK\`.`;

function persona(
	id: string,
	focus: string,
	opts: {
		slot?: ModelSlot;
		effort: ThinkingLevel;
		gating: boolean;
		body: string;
	},
): Persona {
	return {
		id,
		focus,
		slot: opts.slot ?? "default",
		effort: opts.effort,
		gating: opts.gating,
		preamble: `${CONTRACT}\n\n${opts.body}`,
	};
}

/** The built-in starter palette (extendable via settings/registry). */
export const PERSONAS: readonly Persona[] = [
	persona(
		"correctness-review",
		"Logic bugs, edge cases, broken invariants in the diff",
		{
			effort: "high",
			gating: true,
			body: "Hunt defects the author would be embarrassed to ship: logic and off-by-one/boundary errors, unhandled edge and empty/null inputs, broken invariants and state assumptions, race-prone ordering, and mismatches between what the code does and what its name/comments/tests claim. Trace the concrete input that triggers each. Ignore style/naming. BLOCK on any Critical correctness bug.",
		},
	),
	persona(
		"security-audit",
		"Injection, authz, secrets, OWASP-10 in changed code",
		{
			effort: "high",
			gating: true,
			body: "Audit the change against the OWASP Top-10: broken access control / missing authorization, injection (SQL/command/path/template) from untrusted input, missing input validation or output encoding, hardcoded secrets/keys, weak or misused crypto, unsafe deserialization, SSRF, auth/session flaws, and vulnerable or unpinned dependencies. For each finding state the attack: attacker input → tainted sink → impact, with a severity. BLOCK on any High/Critical vulnerability.",
		},
	),
	persona(
		"test-coverage",
		"Untested new behaviors / edge cases; weak or over-mocked tests",
		{
			effort: "medium",
			gating: true,
			body: "Determine whether every new or changed behavior is actually tested, INCLUDING the unhappy paths (errors, empty/boundary inputs, edge conditions). Flag: behavior with no test, tests that assert nothing or only re-assert mocks, over-mocking that hides real integration, and brittle tests coupled to implementation detail. Prefer integration tests for core logic. BLOCK only if a critical-path behavior ships wholly untested; otherwise advisory PASS.",
		},
	),
	persona(
		"simplification",
		"Over-engineering, duplication, dead code, needless complexity",
		{
			effort: "medium",
			gating: false,
			body: "One question: is this more complex than it needs to be RIGHT NOW? Be especially vigilant about over-engineering (YAGNI) — abstraction, generality, or extension points for needs that don't yet exist. Flag speculative generality, duplication, dead code, needless indirection, and control flow that could be flattened. Show current-vs-simpler and confirm behavior is preserved. Argue for LESS code, not different code. Advisory (VERDICT: PASS).",
		},
	),
	persona(
		"error-handling",
		"Swallowed errors, missing failure paths, resource leaks",
		{
			effort: "medium",
			gating: false,
			body: "Examine every new failure point. Flag swallowed/over-broad catches, unhandled fallible operations (I/O, network, parsing, external calls), resources not released on error paths (files, locks, connections, transactions — missing finally/cleanup), state left half-updated, lost error causes, and missing timeouts/retries on remote calls. BLOCK if an unhandled failure can corrupt data or leak a critical resource; else advisory.",
		},
	),
	persona(
		"api-design",
		"Interface shape, naming, backward-compat / breaking changes",
		{
			effort: "medium",
			gating: false,
			body: "Review the shape callers see: signatures, names, parameter order/defaults, return and error contracts, config surfaces. Judge ergonomics, consistency with existing conventions, and naming. Critically, hunt BREAKING CHANGES across public signatures, CLI parameters, config loading, serialized/persisted formats, and session/state resume — enumerate how existing callers or stored data could break and whether a migration/version bump is needed. BLOCK if it breaks a stable public contract without a migration path; advisory for internal-only APIs.",
		},
	),
	persona(
		"documentation",
		'Non-obvious "why", public API / changed-behavior docs',
		{
			effort: "low",
			gating: false,
			body: "Flag documentation gaps (you never write the docs). New/changed public APIs, exported types, flags, or endpoints with no doc; non-obvious logic or workarounds with no comment explaining WHY (not restating what the code does); comments/READMEs/changelogs the change has made stale or wrong; and magic values a maintainer couldn't infer. Do NOT ask for comments on self-evident code — over-commenting is a smell too. Advisory (VERDICT: PASS).",
		},
	),
	persona(
		"performance",
		"N+1, accidental quadratics, hot-path allocations from the diff",
		{
			effort: "medium",
			gating: false,
			body: 'Assess only the runtime cost THIS change introduces or worsens — do not chase pre-existing hot spots. Flag N+1 / per-iteration I/O that could be batched, accidental quadratics from nested loops or repeated scans over growing data, needless hot-path allocations/copies, unbounded memory growth / missing pagination, and redundant work that could be hoisted or cached. Estimate scale ("O(n²) over request count", "one round-trip per row") and give the cheaper approach. If the change is off any hot path, say so. Advisory; escalate to BLOCK only for a clear regression on a known hot path.',
		},
	),
];

const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

export function getPersona(id: string): Persona | undefined {
	return BY_ID.get(id);
}

/**
 * Deterministic sub-agent topology gaps across a plan — the mechanical half of
 * advisor plan-review (the advisor judges the rest: sensitivity, multi-model
 * escalation). Flags code-changing deliverables (worker mode `full`) that:
 *   - have no reviewers at all (nothing checks the change), or
 *   - have reviewers but none `required` (nothing gates ship), or
 *   - carry a gating persona (security/correctness/test-coverage) that isn't
 *     marked `required` — so it produces a verdict that can't actually block.
 * Returns a flat list of human-readable findings (empty = clean).
 */
export function panelTopologyGaps(
	deliverables: readonly Deliverable[],
): string[] {
	const gaps: string[] = [];
	for (const d of deliverables) {
		if (d.worker?.mode !== "full") continue; // read-only deliverables don't change code
		const reviews = (d.subAgents ?? []).filter(
			(s) => (s.kind ?? "review") === "review",
		);
		if (reviews.length === 0) {
			gaps.push(`${d.id} (${d.title}) changes code but has no reviewers.`);
			continue;
		}
		if (!reviews.some((s) => s.required)) {
			gaps.push(
				`${d.id} (${d.title}) has reviewers but none are required — nothing gates ship.`,
			);
		}
		for (const s of reviews) {
			if (getPersona(s.persona)?.gating && !s.required) {
				gaps.push(
					`${d.id}: ${s.name} is a gating persona (${s.persona}) but not marked required.`,
				);
			}
		}
	}
	return gaps;
}

/**
 * Resolve a deliverable's SubAgentSpec to a headless spawn profile: read-only
 * tools in the worker's worktree, the persona body (+ any deliverable focus)
 * as the appended system prompt, isolated extensions (-ne) for a deterministic
 * tool namespace, and the resolved model/effort. Returns null for an unknown
 * persona id (the caller skips it and logs).
 */
export function buildPersonaProfile(
	spec: SubAgentSpec,
	opts: { cwd: string; model?: string },
): SpawnProfile | null {
	const persona = getPersona(spec.persona);
	if (!persona) return null;
	// The harness sets the persona directly — a deterministic identity line,
	// not a sentence the model has to infer. `focus` is the ONE place to say
	// what specifically to scrutinize within that scope for this deliverable.
	const identity = `You are the "${persona.id}" reviewer — ${persona.focus}.`;
	const focusBlock = spec.focus
		? `\n\nFor THIS deliverable, focus specifically on: ${spec.focus}`
		: "";
	const effort = (spec.effort ?? persona.effort) as ThinkingLevel;
	return {
		profile: "research",
		cwd: opts.cwd,
		tools: { allow: [...PERSONA_TOOLS] },
		thinking: effort,
		session: false,
		isolateExtensions: true,
		appendSystemPrompt: `${identity}\n\n${persona.preamble}${focusBlock}`,
		...(opts.model ? { model: opts.model } : {}),
	};
}

export const PERSONA_IDS: readonly string[] = PERSONAS.map((p) => p.id);

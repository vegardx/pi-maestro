import type {
	AgentKind,
	AgentKindDefinition,
	AgentPermissionPolicy,
	AgentRuntimePolicy,
	AgentRuntimePolicyDefinition,
	AgentSessionPolicy,
	AgentTransportPolicy,
} from "@vegardx/pi-contracts";

export class DuplicateRegistryEntryError extends Error {}

/** Small fail-fast registry used for semantic kinds and runtime policy parts. */
export class AgentRegistry<T extends { readonly id: string }> {
	private readonly entries = new Map<string, T>();

	constructor(initial: readonly T[] = []) {
		for (const entry of initial) this.register(entry);
	}

	register(entry: T): void {
		if (this.entries.has(entry.id))
			throw new DuplicateRegistryEntryError(
				`Agent registry entry already exists: ${entry.id}`,
			);
		this.entries.set(entry.id, Object.freeze({ ...entry }));
	}

	require(id: string): T {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown agent registry entry: ${id}`);
		return entry;
	}

	list(): readonly T[] {
		return [...this.entries.values()];
	}
}

export interface AgentRuntimeRegistries {
	readonly permissions: AgentRegistry<AgentPermissionPolicy>;
	readonly sessions: AgentRegistry<AgentSessionPolicy>;
	readonly transports: AgentRegistry<AgentTransportPolicy>;
	readonly policies: AgentRegistry<AgentRuntimePolicyDefinition>;
}

export interface AgentRegistries {
	readonly kinds: AgentRegistry<AgentKindDefinition>;
	readonly runtime: AgentRuntimeRegistries;
}

export function resolveRuntimePolicy(
	registries: AgentRuntimeRegistries,
	id: string,
): AgentRuntimePolicy {
	const composition = registries.policies.require(id);
	const permissions = registries.permissions.require(composition.permissions);
	const session = registries.sessions.require(composition.session);
	const transport = registries.transports.require(composition.transport);
	return {
		mode: permissions.mode,
		tools: permissions.tools,
		session: session.session,
		transport: transport.transport,
		...(session.maxTurns !== undefined ? { maxTurns: session.maxTurns } : {}),
		...(transport.timeoutMs !== undefined
			? { timeoutMs: transport.timeoutMs }
			: {}),
	};
}

export function validateKindRegistry(registries: AgentRegistries): void {
	for (const kind of registries.kinds.list()) {
		resolveRuntimePolicy(registries.runtime, kind.runtimePolicy);
		if (kind.watchdog.softMs !== undefined && !kind.watchdog.wrapUpSteer) {
			throw new Error(
				`Agent kind ${kind.id} has a soft watchdog without wrap-up guidance`,
			);
		}
	}
}

const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const WEB_TOOLS = ["websearch", "webfetch", "context7"] as const;
const DEFAULT_WATCHDOG = {
	stallMs: 120_000,
	softMs: 240_000,
	hardMs: 600_000,
	wrapUpSteer:
		"Time budget nearly exhausted. Stop now and write the required final deliverable from the evidence already gathered; state what remains unknown.",
} as const;

const REPORT_CONTRACT = {
	id: "bounded-report",
	description:
		"The final message is the complete factual deliverable with evidence and explicit unknowns.",
	maxWords: 700,
} as const;
const DIGEST_CONTRACT = {
	id: "research-digest",
	description:
		"End with a dense, self-sufficient digest of at most six lines and 500 characters.",
	requiredMarkers: ["## Digest"],
} as const;
const REVIEW_CONTRACT = {
	id: "structured-review",
	description:
		"Number findings with severity, file:line, failing scenario, and fix; block only for critical or major defects.",
	requiredMarkers: ["VERDICT:"],
} as const;
const VERIFY_CONTRACT = {
	id: "scoped-verification",
	description:
		"Verify only listed claims against immutable evidence and report each as verified or still-open.",
	requiredMarkers: ["VERDICT:"],
} as const;

const RESEARCH_BASE = `You are a research agent working for a planning maestro. Answer only the supplied brief. You are read-only and must never modify files. Your entire final message is consumed programmatically.

Write precise findings with evidence (file:line for repository claims and URLs for web claims), plus what you could not determine. End with a \`## Digest\` block of at most 6 lines / 500 characters containing the answer, load-bearing facts, and any caveat. Findings must be at most 700 words. Cite sources instead of quoting walls of text.`;

const ADVISOR_BASE = `You are a technical advisor consulted by an agent that is doing the actual work. Propose an approach, argue the trade-offs, and recommend a concrete direction — but you NEVER modify files: you advise, the caller decides and acts.

You are persistent: the caller consults you repeatedly over one problem, so build on what you have already said instead of restarting. To ground advice in fact, you may spawn your own read-only research (explorers) and synthesize their findings — the caller sees only your synthesized guidance, not the raw research.

Each reply is a focused recommendation: the approach, the key trade-offs, the risks, and what you would do. Cite evidence (file:line, sources) for load-bearing claims and state what you could not determine. Distinct from an explorer, whose job is to establish facts: your job is judgment.`;

const REVIEW_BASE = `You are a read-only reviewer. Inspect the requested change and surrounding code. Report numbered findings with file:line, severity, failing scenario, and a concrete fix. critical means data loss, security hole, crash, or silently wrong results; major means a real user-visible defect; minor is advisory and never blocks. End with VERDICT: PASS or VERDICT: BLOCK; block if and only if a critical or major finding remains. Your entire final message is the report.`;

function reviewKind(
	id: Extract<
		AgentKind,
		| "practical-review"
		| "adversarial-review"
		| "correctness-review"
		| "security-review"
		| "test-review"
		| "simplification-review"
	>,
	routingSummary: string,
	focus: string,
): AgentKindDefinition {
	return {
		id,
		routingSummary,
		prompt: `${REVIEW_BASE}\n\nFocus: ${focus}`,
		runtimePolicy: "review",
		modelRole: id,
		contracts: [REVIEW_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "parallel",
			guidance: "Run with other independent review lenses in one batch.",
		},
		reducer: "review-findings",
	};
}

export const BUILTIN_AGENT_KINDS: readonly AgentKindDefinition[] = [
	{
		id: "host",
		routingSummary: "The current coordinating session; never spawned.",
		prompt: "Coordinate the active workflow.",
		runtimePolicy: "host",
		modelRole: "worker",
		contracts: [],
		watchdog: {},
		sequencing: { mode: "serial", guidance: "There is one host." },
		reducer: "identity",
	},
	{
		id: "worker",
		routingSummary: "Implement a planned deliverable in its worktree.",
		prompt:
			"Implement exactly the assigned deliverable. Work only in the supplied worktree, keep the plan current, validate the change, and return a concise completion summary.",
		runtimePolicy: "worker",
		modelRole: "worker",
		contracts: [REPORT_CONTRACT],
		watchdog: {},
		sequencing: {
			mode: "parallel",
			guidance: "Parallelize only independent deliverables in the plan DAG.",
		},
		reducer: "identity",
	},
	{
		id: "general",
		routingSummary: "A focused read-only assignment with no narrower kind.",
		prompt:
			"You are a focused general-purpose agent. Do exactly the supplied task, remain read-only, and make your entire final message the deliverable. Be factual and complete; do not add a preamble or offer further help.",
		runtimePolicy: "read-only",
		modelRole: "general",
		contracts: [REPORT_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "parallel",
			guidance:
				"Batch independent assignments; serialize assignments that consume earlier results.",
		},
		reducer: "identity",
	},
	{
		id: "codebase-research",
		routingSummary: "Establish repository facts, patterns, seams, and tests.",
		prompt: `${RESEARCH_BASE}\n\nScope: this repository. Use read, grep, find, and ls to establish facts and cite file:line evidence.`,
		runtimePolicy: "research-codebase",
		modelRole: "codebase-research",
		contracts: [REPORT_CONTRACT, DIGEST_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "parallel",
			guidance: "Batch narrow independent questions in one round.",
		},
		reducer: "research-digest",
	},
	{
		id: "web-research",
		routingSummary:
			"Research current public sources and library documentation.",
		prompt: `${RESEARCH_BASE}\n\nScope: public internet plus the repository. Use web search, page fetch, and library documentation. Prefer primary sources and include dates for time-sensitive facts.`,
		runtimePolicy: "research-web",
		modelRole: "web-research",
		contracts: [REPORT_CONTRACT, DIGEST_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "parallel",
			guidance: "Batch narrow independent questions in one round.",
		},
		reducer: "research-digest",
	},
	{
		id: "plan-review",
		routingSummary:
			"Challenge a draft plan's assumptions, gaps, and sequencing.",
		prompt: `${RESEARCH_BASE}\n\nAct as a second-opinion plan reviewer. Challenge assumptions, identify missing work, risky sequencing, weak acceptance criteria, and under-covered review topology. Recommend concrete changes.`,
		runtimePolicy: "research-codebase",
		modelRole: "plan-review",
		contracts: [REPORT_CONTRACT, DIGEST_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "serial",
			guidance: "Run after a draft structure exists and before execution.",
		},
		reducer: "research-digest",
	},
	reviewKind(
		"practical-review",
		"Find defects users and maintainers will hit in normal use.",
		"Practical runtime behavior, maintainability, compatibility, and operational failure modes.",
	),
	reviewKind(
		"adversarial-review",
		"Attack assumptions and boundary conditions.",
		"Adversarial inputs, races, stale state, retries, partial failure, and abuse cases.",
	),
	{
		...reviewKind(
			"correctness-review",
			"Prove invariants and identify silently wrong behavior.",
			"State transitions, data invariants, ordering, concurrency, and exact contract compliance.",
		),
		// Also maestro-invocable as `/code-review` (report-only) — see
		// docs/design/persona-commands.md. The same persona still runs inside a
		// worker's review() panel; the command is an additional door.
		command: {
			name: "code-review",
			description:
				"Review code changes for correctness (invariants, ordering, concurrency, contracts).",
			instruction:
				"Review code for correctness. If the user did not name a target, review the current uncommitted changes; if there are none, review the working tree at HEAD. Report findings as file:line with severity and a concrete fix.",
		},
	},
	reviewKind(
		"security-review",
		"Inspect trust boundaries and exploitability.",
		"Authorization, injection, secret exposure, filesystem/process boundaries, and realistic exploit paths.",
	),
	reviewKind(
		"test-review",
		"Assess whether tests detect meaningful regressions.",
		"Missing scenarios, false-positive tests, process fakes, determinism, and contract coverage.",
	),
	reviewKind(
		"simplification-review",
		"Reduce accidental complexity without changing behavior.",
		"Unnecessary abstractions, duplicated paths, dead compatibility, and smaller safer designs.",
	),
	{
		id: "verifier",
		routingSummary: "Scope-lock verification to named findings and evidence.",
		prompt:
			"You are a scope-locked verifier. Verify only the listed claims and resolutions against the specified immutable change. Do not perform a fresh open-ended review or expand scope. For every finding report verified or still-open with evidence, then end with VERDICT: PASS or VERDICT: BLOCK.",
		runtimePolicy: "review",
		modelRole: "verifier",
		contracts: [VERIFY_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "parallel",
			guidance:
				"Verify independent finding groups in parallel after fixes are committed.",
		},
		reducer: "verification",
	},
	{
		id: "delivery-verifier",
		routingSummary:
			"Deep-verify a started deliverable's diff against its claimed tasks.",
		prompt:
			"You are a read-only delivery verifier. Read the deliverable's actual diff and judge, task by task, whether the claimed work was genuinely accomplished. Report each task as verified or still-open with evidence, then end with VERDICT: PASS or VERDICT: FAIL.",
		runtimePolicy: "read-only",
		modelRole: "verifier",
		contracts: [VERIFY_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "parallel",
			guidance: "Verify independent started deliverables in parallel.",
		},
		reducer: "verification",
		// Maestro-invocable as `/verify` — fans out over started deliverables.
		command: {
			name: "verify",
			description:
				"Deep-verify started deliverables: read-only agents read each deliverable's real diff and judge whether its tasks were genuinely done.",
			instruction:
				"Verify started deliverables against their real diffs. If the user did not name a deliverable, verify all started ones; otherwise verify only the named deliverable.",
			target: "deliverables",
		},
	},
	{
		id: "advisor",
		routingSummary:
			"Consult on approach and trade-offs; read-only, persistent, never writes code.",
		prompt: ADVISOR_BASE,
		runtimePolicy: "advisor",
		modelRole: "advisor",
		contracts: [REPORT_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		// Persistent standby: spawned once, driven by the caller via `ask` over
		// the caller's lifetime (docs/design/multi-model-agents.md §6).
		standby: true,
		sequencing: {
			mode: "serial",
			guidance:
				"Consult an advisor while you implement; you remain the single author.",
		},
		reducer: "identity",
	},
];

export function createBuiltinAgentRegistries(): AgentRegistries {
	const permissions = new AgentRegistry<AgentPermissionPolicy>([
		{
			id: "host",
			mode: "full",
			tools: {},
		},
		{
			id: "worker",
			mode: "full",
			tools: {},
		},
		{
			id: "read-only",
			mode: "read-only",
			tools: { allow: READ_TOOLS },
		},
		{
			id: "web-read-only",
			mode: "read-only",
			tools: { allow: [...READ_TOOLS, ...WEB_TOOLS] },
			extraExtensions: ["research-tools"],
		},
		{
			// Read-only, but holds the `agent` tool so it can spawn its own
			// read-only research (explorers) to ground its advice, and the web
			// tools to consult sources. Never writes.
			id: "advisor",
			mode: "read-only",
			tools: { allow: [...READ_TOOLS, ...WEB_TOOLS, "agent"] },
			extraExtensions: ["research-tools"],
		},
	]);
	const sessions = new AgentRegistry<AgentSessionPolicy>([
		{ id: "host", session: "persistent" },
		{ id: "worker", session: "persistent" },
		{ id: "advisor", session: "persistent" },
		{ id: "one-shot", session: "ephemeral", maxTurns: 24 },
	]);
	const transports = new AgentRegistry<AgentTransportPolicy>([
		{ id: "host", transport: "host" },
		{ id: "headless", transport: "headless", timeoutMs: 600_000 },
	]);
	const policies = new AgentRegistry<AgentRuntimePolicyDefinition>([
		{ id: "host", permissions: "host", session: "host", transport: "host" },
		{
			id: "worker",
			permissions: "worker",
			session: "worker",
			transport: "headless",
		},
		{
			id: "read-only",
			permissions: "read-only",
			session: "one-shot",
			transport: "headless",
		},
		{
			id: "research-codebase",
			permissions: "read-only",
			session: "one-shot",
			transport: "headless",
		},
		{
			id: "research-web",
			permissions: "web-read-only",
			session: "one-shot",
			transport: "headless",
		},
		{
			id: "review",
			permissions: "read-only",
			session: "one-shot",
			transport: "headless",
		},
		{
			id: "advisor",
			permissions: "advisor",
			session: "advisor",
			transport: "headless",
		},
	]);
	const registries = {
		kinds: new AgentRegistry(BUILTIN_AGENT_KINDS),
		runtime: { permissions, sessions, transports, policies },
	};
	validateKindRegistry(registries);
	return registries;
}

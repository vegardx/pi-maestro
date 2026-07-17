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
		isolation: permissions.isolation,
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
		id: "consult",
		routingSummary: "Make an unbiased recommendation on a specific fork.",
		prompt: `${RESEARCH_BASE}\n\nAct as an unbiased advisor. The caller deliberately withheld its preference. Weigh the options against stated goals, verify relevant facts, commit to one recommendation, and end with RECOMMENDATION: <option>.`,
		runtimePolicy: "research-codebase",
		modelRole: "consult",
		contracts: [REPORT_CONTRACT, DIGEST_CONTRACT],
		watchdog: DEFAULT_WATCHDOG,
		sequencing: {
			mode: "serial",
			guidance: "Consult only after the options and constraints are known.",
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
	reviewKind(
		"correctness-review",
		"Prove invariants and identify silently wrong behavior.",
		"State transitions, data invariants, ordering, concurrency, and exact contract compliance.",
	),
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
];

export function createBuiltinAgentRegistries(): AgentRegistries {
	const permissions = new AgentRegistry<AgentPermissionPolicy>([
		{
			id: "host",
			mode: "full",
			tools: {},
			isolation: "host",
		},
		{
			id: "worker",
			mode: "full",
			tools: {},
			isolation: "lightweight",
		},
		{
			id: "read-only",
			mode: "read-only",
			tools: { allow: READ_TOOLS },
			isolation: "strong",
		},
		{
			id: "web-read-only",
			mode: "read-only",
			tools: { allow: [...READ_TOOLS, ...WEB_TOOLS] },
			isolation: "strong",
			extraExtensions: ["research-tools"],
		},
	]);
	const sessions = new AgentRegistry<AgentSessionPolicy>([
		{ id: "host", session: "persistent" },
		{ id: "worker", session: "persistent" },
		{ id: "one-shot", session: "ephemeral", maxTurns: 24 },
	]);
	const transports = new AgentRegistry<AgentTransportPolicy>([
		{ id: "host", transport: "host" },
		{ id: "tmux", transport: "tmux", timeoutMs: 600_000 },
		{ id: "headless", transport: "headless", timeoutMs: 600_000 },
	]);
	const policies = new AgentRegistry<AgentRuntimePolicyDefinition>([
		{ id: "host", permissions: "host", session: "host", transport: "host" },
		{
			id: "worker",
			permissions: "worker",
			session: "worker",
			transport: "tmux",
		},
		{
			id: "read-only",
			permissions: "read-only",
			session: "one-shot",
			transport: "tmux",
		},
		{
			id: "research-codebase",
			permissions: "read-only",
			session: "one-shot",
			transport: "tmux",
		},
		{
			id: "research-web",
			permissions: "web-read-only",
			session: "one-shot",
			transport: "tmux",
		},
		{
			id: "review",
			permissions: "read-only",
			session: "one-shot",
			transport: "tmux",
		},
	]);
	const registries = {
		kinds: new AgentRegistry(BUILTIN_AGENT_KINDS),
		runtime: { permissions, sessions, transports, policies },
	};
	validateKindRegistry(registries);
	return registries;
}

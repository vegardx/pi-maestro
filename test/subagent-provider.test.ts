// The plan check as one delegated attempt, and the mode's ceiling.
//
// The service provider is REAL here: the fake service is registered through
// pi-subagent's own `registerSubagentServiceProvider` on a fake bus, so
// discovery, the contract comparison and the replacement check are the shipped
// ones rather than a mock of them. What is faked is the attempt — preflight,
// launch, wait — because that is the part a test cannot afford to run.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RUNTIME_CONTRACT } from "@vegardx/pi-subagent";
import { registerSubagentServiceProvider } from "@vegardx/pi-subagent/service-provider";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { Plan } from "../packages/maestro/src/plan.js";
import {
	PlanCheckOutputSchema,
	type PlanCheckResult,
} from "../packages/maestro/src/plan-check.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import {
	createSubagentPlanCheck,
	maestroAgentsDir,
	PLAN_CHECK_CEILING,
	PLAN_CHECK_LIMITS,
	PLAN_CHECK_OWNER_ID,
	PLAN_CHECK_TIMEOUT_MS,
	PLAN_REVIEWER_AGENT,
	planCheckOperationId,
	planCheckRequest,
	REQUIRED_SUBAGENT_CONTRACT_REVISION,
	REQUIRED_SUBAGENT_FEATURES,
	subagentContractMismatch,
	UNAVAILABLE_ABORTED,
	UNAVAILABLE_REFUSED,
	UNAVAILABLE_UNREADABLE,
	unavailableTimeout,
} from "../packages/maestro/src/subagent-provider.js";

const DESCRIPTION =
	"We are shipping the component catalogue so that every workflow stops" +
	" re-authoring the same four stages.";

const PLAN: Plan = {
	slug: "compose",
	title: "Compose the catalogue",
	repos: [{ key: "wf", path: "/nowhere/pi-workflow" }],
	deliverables: [
		{
			id: "d1",
			title: "One",
			after: [],
			reads: [],
			tasks: [{ id: "impl", title: "Work" }],
		},
	],
} as unknown as Plan;

const APPROVED: PlanCheckResult = {
	verdict: "approve",
	findings: [],
	notes: "reads fine",
};

/** Pi's bus, as much of it as either provider uses. */
function fakeBus(): EventBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel: string, data: unknown) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			handlers.set(channel, set);
			set.add(handler);
			return () => set.delete(handler);
		},
	} as unknown as EventBus;
}

interface FakeAttempt {
	readonly status?: string;
	readonly failure?: { readonly code: string };
	readonly structuredOutput?: unknown;
	/** A wait that never settles, for the timeout path. */
	readonly hang?: true;
}

/** A service whose one client answers the four calls a check makes. */
function fakeService(attempt: FakeAttempt = {}) {
	const owners: unknown[] = [];
	const requests: unknown[] = [];
	const interrupted: string[] = [];
	const client = {
		preflight: async (request: unknown) => {
			requests.push(request);
			return { preflightId: "pf-1", identitySha256: "a".repeat(64) };
		},
		launch: async () => ({ runId: "sr-1" }),
		wait: async () =>
			attempt.hang
				? new Promise<never>(() => undefined)
				: {
						result: {
							status: attempt.status ?? "completed",
							...(attempt.failure ? { failure: attempt.failure } : {}),
						},
						structuredOutput:
							"structuredOutput" in attempt
								? attempt.structuredOutput
								: APPROVED,
					},
		interrupt: async (runId: string) => {
			interrupted.push(runId);
			return { runId };
		},
	};
	const service = {
		forOwner: (owner: unknown) => {
			owners.push(owner);
			return client;
		},
	};
	return { service, owners, requests, interrupted };
}

function plant(bus: EventBus, attempt: FakeAttempt = {}) {
	const fake = fakeService(attempt);
	registerSubagentServiceProvider(bus, async () => fake.service as never);
	return fake;
}

function check(
	bus: EventBus,
	options: { readonly timeoutMs?: number; readonly noContext?: true } = {},
) {
	return createSubagentPlanCheck({
		events: bus,
		context: () => (options.noContext ? undefined : ({} as never)),
		cwd: "/work/project",
		sessionId: () => "session-1",
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
	});
}

// ── The request ──────────────────────────────────────────────────────────────

describe("what a plan check launches", () => {
	const request = planCheckRequest({
		plan: PLAN,
		description: DESCRIPTION,
		cwd: "/work/project",
		round: 0,
	});

	it("names this package's own definition, at this package's own root", () => {
		expect(request.agent).toBe(PLAN_REVIEWER_AGENT);
		expect(request.agentRoots).toEqual([maestroAgentsDir()]);
		// The definition the request names is shipped beside the code that names
		// it, which is what `agentRoots` buys: not whatever a project has.
		expect(
			existsSync(join(maestroAgentsDir(), `${PLAN_REVIEWER_AGENT}.md`)),
		).toBe(true);
	});

	it("is blind: a fresh context, no scopes, and only the plan and the description", () => {
		expect(request.contextMode).toBe("fresh");
		// THE POINT OF THE WHOLE CHECK. pi-subagent unions the agent's scopes with
		// the request's, so an empty list on both sides is what keeps `AGENTS.md`
		// and every other project context file out of the reader.
		expect(request.contextScopes).toEqual([]);
		expect(request.preloadSkills).toEqual([]);
		const context = request.task.context.join("\n");
		expect(context).toContain(DESCRIPTION);
		expect(context).toContain('"slug": "compose"');
		expect(request.task.goal).toContain("`compose`");
		expect(request.task.goal).toContain("you were not in the");
	});

	it("reads and never writes, under a ceiling that says so twice", () => {
		expect(request.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(request.workspace).toEqual({
			mode: "read-only",
			cwd: "/work/project",
		});
		expect(request.ceiling).toEqual({ workspaceModes: ["read-only"] });
		expect(PLAN_CHECK_CEILING.workspaceModes).toEqual(["read-only"]);
		expect(request.limits.workspaceWriteBytes).toBe(0);
		// No retry underneath the harness's own bound of two rewrites.
		expect(request.limits.retries).toBe(0);
		expect(request.limits.resumes).toBe(0);
		expect(request.limits).toEqual({ ...PLAN_CHECK_LIMITS });
		expect(PLAN_CHECK_LIMITS.attemptTimeoutMs).toBe(PLAN_CHECK_TIMEOUT_MS);
	});

	it("pins the output schema, so findings come back as data", () => {
		expect(request.outputSchema).toBe(PlanCheckOutputSchema);
		expect(request.task.instructions.join("\n")).toContain("needsPerson");
	});

	it("names the operation by the bytes it is checking and the round", () => {
		const digest = planDigest(PLAN).slice(0, 16);
		expect(planCheckOperationId(PLAN, 0)).toBe(
			`${PLAN_CHECK_OWNER_ID}:${digest}:0`,
		);
		// Same bytes, same round, same operation: pi-subagent's launch is
		// idempotent per operation, so an asked-twice check is one run.
		expect(planCheckOperationId(PLAN, 0)).toBe(planCheckOperationId(PLAN, 0));
		expect(planCheckOperationId(PLAN, 1)).not.toBe(
			planCheckOperationId(PLAN, 0),
		);
		// A rewrite changes the digest, which is honestly a different reading.
		const rewritten = { ...PLAN, title: "Compose it again" } as Plan;
		expect(planCheckOperationId(rewritten, 0)).not.toBe(
			planCheckOperationId(PLAN, 0),
		);
	});
});

describe("the definition the check runs", () => {
	const template = readFileSync(
		join(maestroAgentsDir(), `${PLAN_REVIEWER_AGENT}.md`),
		"utf8",
	);

	it("declares the ceiling the launch relies on", () => {
		expect(template).toContain(`name: ${PLAN_REVIEWER_AGENT}`);
		expect(template).toContain("workspaceModes: [read-only]");
		expect(template).toContain("contextScopes: []");
		expect(template).toContain("preloadSkills: []");
		expect(template).toContain("tools: [read, grep, find, ls]");
		expect(template).toContain("workspaceWriteBytes: 0");
		// The model pin convention of the other templates: one exact model and an
		// `allowedModels` list that bounds it.
		expect(template).toMatch(/^model: \{ provider: /m);
		expect(template).toContain("allowedModels:");
	});

	it("says what `needsPerson` costs, because that is the field with teeth", () => {
		expect(template).toContain("needsPerson");
		expect(template).toContain("direction");
		expect(template).toContain("untrusted");
		// The things the old blind reviewer checked and this one must not: the
		// compiled graph and the policy are not in this document.
		expect(template).toContain("not yours to check");
		expect(template).toContain("out of scope");
	});
});

// ── The output schema ────────────────────────────────────────────────────────

describe("the schema the reviewer is held to", () => {
	it("accepts a well-formed answer and refuses everything else", () => {
		expect(
			Value.Check(PlanCheckOutputSchema, {
				verdict: "blocked",
				findings: [
					{
						id: "f1",
						severity: "blocking",
						where: "deliverable d1",
						summary: "nothing tests it",
						direction: "add a task",
						needsPerson: false,
					},
				],
				notes: "",
			}),
		).toBe(true);
		for (const bad of [
			{ verdict: "ready", findings: [], notes: "" },
			{ verdict: "approve", findings: [] },
			{ verdict: "approve", findings: [{ id: "f1" }], notes: "" },
			{
				verdict: "approve",
				findings: [],
				notes: "",
				extra: "not in the schema",
			},
		])
			expect(Value.Check(PlanCheckOutputSchema, bad)).toBe(false);
	});
});

// ── The contract ─────────────────────────────────────────────────────────────

describe("the pi-subagent this seat was built against", () => {
	it("matches the installed runtime", () => {
		expect(subagentContractMismatch()).toBeUndefined();
		expect(SUBAGENT_RUNTIME_CONTRACT.contractRevision).toBe(
			REQUIRED_SUBAGENT_CONTRACT_REVISION,
		);
	});

	it("names the revision it found and the one it wanted", () => {
		expect(
			subagentContractMismatch({
				...SUBAGENT_RUNTIME_CONTRACT,
				contractRevision: 99,
			} as never),
		).toContain(
			`revision 99, and this seat was built against ${REQUIRED_SUBAGENT_CONTRACT_REVISION}`,
		);
	});

	it("names a feature the check needs and the runtime does not offer", () => {
		for (const feature of REQUIRED_SUBAGENT_FEATURES)
			expect(
				subagentContractMismatch({
					...SUBAGENT_RUNTIME_CONTRACT,
					features: { ...SUBAGENT_RUNTIME_CONTRACT.features, [feature]: false },
				} as never),
			).toContain(`\`${feature}: false\``);
	});
});

// ── The check itself ─────────────────────────────────────────────────────────

describe("the check against the shared service", () => {
	it("returns the reviewer's structured output as the result", async () => {
		const bus = fakeBus();
		const fake = plant(bus);
		await expect(check(bus)(PLAN, DESCRIPTION)).resolves.toEqual(APPROVED);
		// Registered under an owner that says who asked, with the session it was
		// asked in.
		expect(fake.owners).toEqual([
			{ id: PLAN_CHECK_OWNER_ID, parentSessionId: "session-1" },
		]);
		expect(fake.requests.length).toBe(1);
	});

	it("counts its own rounds, so two checks in one hand-off are two launches", async () => {
		const bus = fakeBus();
		const fake = plant(bus);
		const subject = check(bus);
		await subject(PLAN, DESCRIPTION);
		await subject(PLAN, DESCRIPTION);
		expect(
			fake.requests.map((r) => (r as { operationId: string }).operationId),
		).toEqual([planCheckOperationId(PLAN, 0), planCheckOperationId(PLAN, 1)]);
	});

	it("is unavailable, naming pi-subagent's own refusal, when nothing is registered", async () => {
		const bus = fakeBus();
		await expect(check(bus)(PLAN, DESCRIPTION)).resolves.toEqual({
			unavailable: "No pi-subagent service provider is registered.",
		});
	});

	it("is unavailable when the session has no live context to acquire with", async () => {
		const bus = fakeBus();
		plant(bus);
		await expect(
			check(bus, { noContext: true })(PLAN, DESCRIPTION),
		).resolves.toMatchObject({
			unavailable: expect.stringContaining("no live context"),
		});
	});

	it("says what the attempt ended as, in the runtime's own classified words", async () => {
		const bus = fakeBus();
		plant(bus, { status: "failed", failure: { code: "provider-transient" } });
		await expect(check(bus)(PLAN, DESCRIPTION)).resolves.toEqual({
			unavailable: "the reviewer ended `failed` (provider-transient)",
		});
	});

	it("is unavailable when the output is not a result this seat can read", async () => {
		const bus = fakeBus();
		plant(bus, { structuredOutput: { verdict: "ready", findings: [] } });
		await expect(check(bus)(PLAN, DESCRIPTION)).resolves.toEqual({
			unavailable: UNAVAILABLE_UNREADABLE,
		});
	});

	it("stops waiting on its own bound, and interrupts the attempt", async () => {
		const bus = fakeBus();
		const fake = plant(bus, { hang: true });
		await expect(
			check(bus, { timeoutMs: 5 })(PLAN, DESCRIPTION),
		).resolves.toEqual({ unavailable: unavailableTimeout(5) });
		expect(fake.interrupted).toEqual(["sr-1"]);
	});

	it("stops on the abort signal and says so, not that it timed out", async () => {
		const bus = fakeBus();
		const fake = plant(bus, { hang: true });
		const live = new AbortController();
		const running = check(bus, { timeoutMs: 60_000 })(
			PLAN,
			DESCRIPTION,
			live.signal,
		);
		// One macrotask, so the launch has happened and the flow is inside the
		// wait: a session replaced while the reviewer is running is the case the
		// interrupt exists for.
		await new Promise((resolve) => setTimeout(resolve, 0));
		live.abort();
		await expect(running).resolves.toEqual({
			unavailable: UNAVAILABLE_ABORTED,
		});
		expect(fake.interrupted).toEqual(["sr-1"]);
	});

	it("stops between preflight and launch without starting an attempt", async () => {
		const bus = fakeBus();
		const fake = plant(bus);
		const live = new AbortController();
		const running = check(bus)(PLAN, DESCRIPTION, live.signal);
		live.abort();
		await expect(running).resolves.toEqual({
			unavailable: UNAVAILABLE_ABORTED,
		});
		// Preflight happened; nothing was launched, so there is nothing to
		// interrupt and nothing was spent.
		expect(fake.requests.length).toBe(1);
		expect(fake.interrupted).toEqual([]);
	});

	it("refuses before acquiring anything when the signal is already aborted", async () => {
		const bus = fakeBus();
		const fake = plant(bus);
		const live = new AbortController();
		live.abort();
		await expect(check(bus)(PLAN, DESCRIPTION, live.signal)).resolves.toEqual({
			unavailable: UNAVAILABLE_ABORTED,
		});
		expect(fake.requests).toEqual([]);
	});

	it("never leaks a stray failure's own words", async () => {
		const bus = fakeBus();
		registerSubagentServiceProvider(bus, async () => {
			throw new Error("ENOENT /Users/somebody/.pi/secrets.json");
		});
		await expect(check(bus)(PLAN, DESCRIPTION)).resolves.toEqual({
			unavailable: UNAVAILABLE_REFUSED,
		});
	});
});

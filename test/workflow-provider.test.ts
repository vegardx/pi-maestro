// The consumer side of the workflow provider seam, on a fake bus.
//
// Two things are under test and they fail for different reasons.
//
// **The cross-repo copy.** pi-maestro cannot import
// `WORKFLOW_RUNTIME_CONTRACT`: `@vegardx/pi-workflow` is an optional peer and
// is not on npm, so a seat without it must still typecheck and run. The
// contract is therefore written out twice, and the second copy is pinned here
// against `test/fixtures/pi-workflow-runtime-contract.json` — a byte copy of
// pi-workflow's own shipped constant, taken from its built `dist/contracts.js`
// and **refreshed by hand** when its revision moves. If the copies disagree,
// this file fails; that is the whole mechanism (spec D3).
//
// **The discovery and the refusals.** Everything that can go wrong at the seam
// has to end as a warning naming what a human can do instead, and never as an
// exception inside a dialog sequence.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isCompatibleWorkflowContract,
	REQUIRED_WORKFLOW_CONTRACT,
	REQUIRED_WORKFLOW_FEATURES,
	workflowContractMismatch,
} from "../packages/maestro/src/workflow-contract.js";
import {
	acquireWorkflowClient,
	acquireWorkflowClientOrWarn,
	callWorkflow,
	classifyWorkflowFailure,
	discoverWorkflowProvider,
	WORKFLOW_SERVICE_REQUEST_CHANNEL,
	WORKFLOW_SERVICE_REQUEST_SCHEMA,
	type WorkflowEventBus,
	WorkflowProviderError,
	type WorkflowProviderErrorCode,
	workflowProviderWarning,
} from "../packages/maestro/src/workflow-provider.js";

const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"pi-workflow-runtime-contract.json",
);

type ShippedContract = {
	schema: string;
	contractRevision: number;
	requiredSubagent: {
		schema: string;
		contractRevision: number;
		features: Record<string, boolean>;
	};
	features: Record<string, boolean>;
};

const shipped = JSON.parse(readFileSync(FIXTURE, "utf8")) as ShippedContract;

// ── A fake bus ───────────────────────────────────────────────────────────────
//
// `emit` is synchronous in Pi's own bus, and discovery depends on that: every
// handler has answered by the time `emit` returns. The fake keeps that
// property and nothing else.

interface FakeBus extends WorkflowEventBus {
	readonly emitted: { channel: string; data: unknown }[];
}

function createFakeBus(): FakeBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emitted: { channel: string; data: unknown }[] = [];
	return {
		emitted,
		emit(channel, data) {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			handlers.set(channel, set);
			set.add(handler);
			return () => set.delete(handler);
		},
	};
}

function clientStub(
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		list: async () => [],
		validate: async () => ({ valid: true, workflow: { name: "plan-to-ship" } }),
		project: async () => ({
			cost: 0,
			totalTokens: 0,
			childRuntimeMs: 0,
			tasks: 0,
			fits: true,
		}),
		inspect: async () => ({}),
		runs: async () => ({ runs: [] }),
		observe: () => () => {},
		startBuiltin: async () => ({ runId: "r" }),
		// Revision 22: the seat's three dialogs ARE these three calls, so a client
		// without one is refused at discovery rather than found wanting inside the
		// dialog that needed it.
		decide: async () => ({}),
		resume: async () => ({}),
		stop: async () => ({}),
		...overrides,
	};
}

/** A provider shaped exactly like the one pi-workflow registers. */
function providerStub(
	options: { contract?: unknown; acquire?: unknown; client?: unknown } = {},
): { contract: unknown; acquire: unknown } {
	return {
		contract: options.contract ?? structuredClone(shipped),
		acquire: options.acquire ?? (async () => options.client ?? clientStub()),
	};
}

function register(bus: WorkflowEventBus, provider: unknown): () => void {
	return bus.on(WORKFLOW_SERVICE_REQUEST_CHANNEL, (data) => {
		const request = data as
			| { schema?: unknown; respond?: (provider: unknown) => void }
			| undefined;
		if (request?.schema !== WORKFLOW_SERVICE_REQUEST_SCHEMA) return;
		request.respond?.(provider);
	});
}

function recorder(): {
	calls: [string, string | undefined][];
	notify: (m: string, t?: "info" | "warning" | "error") => void;
} {
	const calls: [string, string | undefined][] = [];
	return { calls, notify: (message, type) => calls.push([message, type]) };
}

// ── The cross-repo copy ──────────────────────────────────────────────────────

describe("REQUIRED_WORKFLOW_CONTRACT against pi-workflow's shipped contract", () => {
	it("copies the schema name and the contract revision", () => {
		expect(REQUIRED_WORKFLOW_CONTRACT.schema).toBe(shipped.schema);
		expect(REQUIRED_WORKFLOW_CONTRACT.contractRevision).toBe(
			shipped.contractRevision,
		);
	});

	it("names only features the runtime declares, with the values it declares", () => {
		for (const feature of REQUIRED_WORKFLOW_FEATURES) {
			expect(
				shipped.features,
				`pi-workflow no longer declares \`${feature}\``,
			).toHaveProperty(feature);
			expect(REQUIRED_WORKFLOW_CONTRACT.features[feature]).toBe(
				shipped.features[feature],
			);
		}
	});

	it("accepts the shipped contract as compatible", () => {
		expect(workflowContractMismatch(shipped)).toBeUndefined();
		expect(isCompatibleWorkflowContract(shipped)).toBe(true);
	});

	it("is frozen, so no caller can relax what this seat requires", () => {
		expect(Object.isFrozen(REQUIRED_WORKFLOW_CONTRACT)).toBe(true);
		expect(Object.isFrozen(REQUIRED_WORKFLOW_CONTRACT.features)).toBe(true);
	});

	it("refuses a contract that is not one at all", () => {
		expect(workflowContractMismatch(undefined)).toMatch(/not a pi-workflow/);
		expect(workflowContractMismatch({ schema: "pi-workflow-runtime" })).toMatch(
			/not a pi-workflow/,
		);
	});

	it("tolerates a feature key it does not read", () => {
		const grown = structuredClone(shipped);
		grown.features.somethingNew = true;
		expect(workflowContractMismatch(grown)).toBeUndefined();
	});

	it("requires `serviceProviderStart`, because nothing else can start a plan", () => {
		// The exit and `/plan run` both start `plan-to-ship` through
		// `startBuiltin`, and the model is never asked to start one instead —
		// so a runtime without the feature leaves no way to run a plan at all.
		expect(REQUIRED_WORKFLOW_FEATURES).toContain("serviceProviderStart");
		expect(shipped.features.serviceProviderStart).toBe(true);

		const without = structuredClone(shipped);
		delete without.features.serviceProviderStart;
		// Refused by the VALUE check, naming the feature — not by the shape
		// check, whose only answer is "that is not a workflow runtime contract".
		const why = workflowContractMismatch(without);
		expect(why).toContain("serviceProviderStart");
		expect(why).not.toMatch(/not a pi-workflow/);
		expect(isCompatibleWorkflowContract(without)).toBe(false);
	});

	// Revision 22, and the same argument one level along: the seat's three dialogs
	// ARE `decide`, `resume` and `stop`, and the gate's inputs are what
	// `include: ["checkpoints"]` returns. A runtime without the feature leaves the
	// ship decision, the retry/stop offer and the gate's own rendering with nothing
	// to do — which is why it is required rather than degraded around. It was
	// duck-typed while it did not exist, and a duck-typed method is one nothing
	// refuses the absence of.
	it("requires `serviceProviderDecide`, because the dialogs are those calls", () => {
		expect(REQUIRED_WORKFLOW_FEATURES).toContain("serviceProviderDecide");
		expect(shipped.features.serviceProviderDecide).toBe(true);

		const without = structuredClone(shipped);
		delete without.features.serviceProviderDecide;
		const why = workflowContractMismatch(without);
		expect(why).toContain("serviceProviderDecide");
		expect(why).not.toMatch(/not a pi-workflow/);
		expect(isCompatibleWorkflowContract(without)).toBe(false);
	});

	// The fixture is pi-workflow's own constant, so this is the cross-repo pin: the
	// revision this seat was written against, and the pi-subagent revision that
	// runtime needs, both read off the copy rather than restated.
	it("is pinned to revision 22, over pi-subagent revision 9", () => {
		expect(shipped.contractRevision).toBe(22);
		expect(shipped.requiredSubagent.contractRevision).toBe(9);
		expect(shipped.requiredSubagent.features.sessionModelInherit).toBe(true);
	});
});

// ── Discovery ────────────────────────────────────────────────────────────────

describe("discovery", () => {
	it("asks on pi-workflow's channel with pi-workflow's request schema", () => {
		const bus = createFakeBus();
		register(bus, providerStub());
		discoverWorkflowProvider(bus);
		expect(bus.emitted).toHaveLength(1);
		expect(bus.emitted[0]?.channel).toBe(WORKFLOW_SERVICE_REQUEST_CHANNEL);
		expect(bus.emitted[0]?.data).toMatchObject({
			schema: WORKFLOW_SERVICE_REQUEST_SCHEMA,
		});
	});

	it("reports `missing` when nothing answers", async () => {
		const bus = createFakeBus();
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "missing",
		});
	});

	it("reports `duplicate` when two runtimes answer", async () => {
		const bus = createFakeBus();
		register(bus, providerStub());
		register(bus, providerStub());
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "duplicate",
		});
	});

	it("reports `incompatible` for a flipped feature, naming it", async () => {
		const bus = createFakeBus();
		const contract = structuredClone(shipped);
		contract.features.worktrees = false;
		register(bus, providerStub({ contract }));
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "incompatible",
		});
		await expect(acquireWorkflowClient(bus, {})).rejects.toThrow(/worktrees/);
	});

	it("reports `incompatible` for a bumped revision, naming both", async () => {
		const bus = createFakeBus();
		const contract = structuredClone(shipped);
		contract.contractRevision = shipped.contractRevision + 1;
		register(bus, providerStub({ contract }));
		await expect(acquireWorkflowClient(bus, {})).rejects.toThrow(
			new RegExp(
				`${shipped.contractRevision + 1}.*${shipped.contractRevision}`,
			),
		);
	});

	it("reports `incompatible` when `acquire` is not a function", async () => {
		const bus = createFakeBus();
		register(bus, providerStub({ acquire: "run it yourself" }));
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "incompatible",
		});
		await expect(acquireWorkflowClient(bus, {})).rejects.toThrow(/acquire/);
	});

	it("reports `replaced` when the provider changes during acquisition", async () => {
		const bus = createFakeBus();
		const successor = providerStub();
		let unregister: (() => void) | undefined;
		const first = providerStub({
			acquire: async () => {
				// A second workflow extension finishes loading mid-await.
				unregister?.();
				register(bus, successor);
				return clientStub();
			},
		});
		unregister = register(bus, first);
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "replaced",
		});
	});

	it("reports `acquisition` when `acquire` throws", async () => {
		const bus = createFakeBus();
		register(
			bus,
			providerStub({
				acquire: async () => {
					throw new Error("the store is locked");
				},
			}),
		);
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "acquisition",
		});
		await expect(acquireWorkflowClient(bus, {})).rejects.toThrow(
			/the store is locked/,
		);
	});

	it("reports `validation` when the runtime refuses the acquisition itself", async () => {
		const bus = createFakeBus();
		register(
			bus,
			providerStub({
				acquire: async () => {
					throw Object.assign(new Error("Project is not trusted."), {
						name: "WorkflowServiceError",
						code: "validation",
					});
				},
			}),
		);
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "validation",
		});
	});

	it("reports `incompatible` when the client is missing part of the surface", async () => {
		const bus = createFakeBus();
		const client = clientStub();
		// `observe` is what narration and the ship watcher both ride on, so a
		// runtime without it is a runtime this seat cannot follow a run in.
		delete client.observe;
		register(bus, providerStub({ client }));
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "incompatible",
		});
	});

	it("hands back the client when the runtime matches", async () => {
		const bus = createFakeBus();
		const client = clientStub();
		register(bus, providerStub({ client }));
		await expect(acquireWorkflowClient(bus, {})).resolves.toBe(client);
	});
});

// ── The error mapping ────────────────────────────────────────────────────────

describe("every failure becomes one warning naming the fallback", () => {
	const CODES: WorkflowProviderErrorCode[] = [
		"missing",
		"duplicate",
		"incompatible",
		"replaced",
		"validation",
		"acquisition",
	];

	// ONE FALLBACK, because there is one thing a failure on this seam costs: the
	// run. The reviewer's fallback went with the blind review — the plan check is
	// a one-shot subagent and never comes through here — so every code says the
	// same thing about what remains.
	it.each(CODES)("maps `%s` to a warning offering /plan run", (code) => {
		const error = new WorkflowProviderError(code, "the stated reason");
		expect(classifyWorkflowFailure(error)).toBe(code);
		const warning = workflowProviderWarning(error);
		expect(warning).toContain(code);
		expect(warning).toContain("the stated reason");
		expect(warning).toContain("/plan run");
	});

	it("classifies a runtime refusal as `validation` and anything else as `acquisition`", () => {
		const refusal = Object.assign(new Error("nope"), {
			name: "WorkflowServiceError",
			code: "validation",
		});
		expect(classifyWorkflowFailure(refusal)).toBe("validation");
		const persistence = Object.assign(new Error("disk"), {
			name: "WorkflowServiceError",
			code: "persistence",
		});
		expect(classifyWorkflowFailure(persistence)).toBe("acquisition");
		expect(workflowProviderWarning(persistence)).toContain("disk");
		expect(classifyWorkflowFailure("a bare string")).toBe("acquisition");
	});

	it("warns at `warning` severity, once, and returns nothing", async () => {
		const bus = createFakeBus();
		const { calls, notify } = recorder();
		await expect(
			acquireWorkflowClientOrWarn(bus, {}, notify),
		).resolves.toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBe("warning");
		expect(calls[0]?.[0]).toContain("missing");
	});

	it("never throws into the session, even when notify throws", async () => {
		const bus = createFakeBus();
		await expect(
			acquireWorkflowClientOrWarn(bus, {}, () => {
				throw new Error("no UI here");
			}),
		).resolves.toBeUndefined();
	});
});

// ── The runtime's own allowlist ──────────────────────────────────────────────
//
// `runBuiltin` is gone from this client, and with it the headless `plan-review`
// it existed to start. The plan check is a one-shot subagent now, so the only
// thing this seat starts through the runtime is the plan's own run — and that
// is what the allowlist test below is about.

describe("startBuiltin, the plan's own run", () => {
	// The allowlist belongs to the runtime, not to this caller: pi-maestro does
	// not hold a copy and does not pre-check. What it owns is that a refusal
	// arrives as a warning naming `/plan run` rather than as a throw in the
	// middle of the hand-off's confirmation.
	const refusal = Object.assign(
		new Error(
			"Workflow deep-review is not a builtin a service consumer may start; use workflow_run.",
		),
		{ name: "WorkflowServiceError", code: "validation" },
	);

	it("is part of the client surface a compatible runtime must offer", async () => {
		const bus = createFakeBus();
		const client = clientStub();
		delete client.startBuiltin;
		register(bus, providerStub({ client }));
		await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
			code: "incompatible",
		});
	});

	// Every method the seat calls, and each of them alone: a client missing one is
	// refused at discovery, which is the difference between a required method and a
	// duck-typed one.
	it.each(["decide", "resume", "stop"] as const)(
		"refuses a client with no `%s`",
		async (method) => {
			const bus = createFakeBus();
			const client = clientStub();
			delete client[method];
			register(bus, providerStub({ client }));
			await expect(acquireWorkflowClient(bus, {})).rejects.toMatchObject({
				code: "incompatible",
			});
		},
	);

	it("starts `plan-to-ship` with the input, and nothing beside it", async () => {
		const bus = createFakeBus();
		const seen: unknown[] = [];
		register(
			bus,
			providerStub({
				client: clientStub({
					startBuiltin: async (ref: string, options: unknown) => {
						if (ref !== "plan-to-ship") throw refusal;
						seen.push(options);
						return { runId: "run-9" };
					},
				}),
			}),
		);
		const client = await acquireWorkflowClient(bus, {});
		const { calls, notify } = recorder();
		await expect(
			callWorkflow(
				() => client.startBuiltin("plan-to-ship", { input: { plan: {} } }),
				notify,
			),
		).resolves.toEqual({ runId: "run-9" });
		// v8: the plan and its digest, and nothing beside them. The effort that used
		// to travel here was the one field of a start the plan digest did not cover.
		expect(seen).toEqual([{ input: { plan: {} } }]);
		expect(calls).toEqual([]);
	});

	it("surfaces a refused ref as a warning naming `/plan run`", async () => {
		const bus = createFakeBus();
		register(
			bus,
			providerStub({
				client: clientStub({
					startBuiltin: async () => {
						throw refusal;
					},
				}),
			}),
		);
		const client = await acquireWorkflowClient(bus, {});
		const { calls, notify } = recorder();
		const receipt = await callWorkflow(
			() => client.startBuiltin("deep-review", { input: {} }),
			notify,
		);
		expect(receipt).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBe("warning");
		expect(calls[0]?.[0]).toContain("validation");
		expect(calls[0]?.[0]).toContain("/plan run <slug>");
	});
});

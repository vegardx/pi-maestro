// Publication (spec §1.4, §5 "Publication").
//
// Everything here is faked except the module under test: the workflow client is
// a function returning a literal inspection, the audited Bash runner is a
// recorder, the UI is a queue of answers, and the receipt file is a map. That is
// the point — the properties being asserted are about ORDER and about STOPPING,
// and a test that shelled out would be asserting that git works.
//
// The two that matter most, and that no other test can make: nothing runs
// before the digest is checked, and nothing is pushed after anything fails.

import { describe, expect, it } from "vitest";
import type { AuditedBash } from "../packages/maestro/src/bash-tool.js";
import type { Plan, PublishMode } from "../packages/maestro/src/plan.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import {
	appendPublication,
	handoffRef,
	orderDeliverables,
	type PublicationRecord,
	type PublishFiles,
	type PublishUI,
	publishPlan,
	readReceipt,
	resolveHostCheck,
	shipDecision,
	shipPlan,
	watchShippedRuns,
} from "../packages/maestro/src/publish.js";
import { createPlanStore } from "../packages/maestro/src/store.js";

const AGENT_DIR = "/agent";
const PROJECT = "/work/demo-project";
const REPO = "/repo";

/**
 * The real store, asked only where a receipt goes. Nothing here touches a
 * filesystem — the store is never saved to, and every read and write below
 * goes through the fake `files` map — but the PATH is the real one, keyed by
 * project, because that is the thing being asserted.
 */
const planStore = createPlanStore({
	cwd: PROJECT,
	agentDir: AGENT_DIR,
	sessionId: () => "publish-session",
});
const receiptPath = planStore.publicationFile("demo");
const WHEN = new Date(2026, 8, 17, 8, 30);
const BRANCH = "pi-maestro/demo/20260917-0830";

function plan(
	publish: { mode: PublishMode; base?: string } = { mode: "pr", base: "main" },
): Plan {
	return {
		slug: "demo",
		title: "Demo plan",
		repos: [{ key: "main", path: REPO }],
		policy: { publish },
		deliverables: [
			{ id: "first", title: "First", after: [], reads: [], tasks: [] },
			{ id: "second", title: "Second", after: [], reads: [], tasks: [] },
		],
	};
}

const sha = (seed: string) => seed.repeat(64).slice(0, 64);

function descriptor(ordinal: number) {
	return {
		artifactId: `artifact_${sha(String(ordinal))}`,
		runId: "run-1",
		producerTaskId: `task-${ordinal}`,
		producerExecutionId: `exec-${ordinal}`,
		subagentRunId: `sr-${ordinal}`,
		subagentAttemptId: `at-${ordinal}`,
		baselineHead: sha("a"),
		handoffCommit: sha(String(ordinal === 1 ? 1 : 2)),
		format: "git-format-patch",
		mediaType: "application/vnd.pi-subagent.handoff+x-git-patch",
		sha256: sha(ordinal === 1 ? "b" : "c"),
		bytes: 1024 * ordinal,
	};
}

/** What `inspect(runId, {include: ["run","tasks"]})` hands back today. */
function taskShaped(digest: string) {
	return {
		run: { runId: "run-1", status: "completed", cwd: REPO },
		receipt: { planDigest: digest },
		tasks: [
			{ key: "refine", kind: "agent", status: "completed" },
			{
				key: "implement-first",
				kind: "agent",
				status: "completed",
				handoff: descriptor(1),
			},
			{
				key: "implement-second",
				kind: "agent",
				status: "completed",
				handoff: descriptor(2),
			},
		],
	};
}

/** What the run's own output says, with the descriptor nested under `handoff`. */
function outputShaped(digest: string) {
	return {
		run: { runId: "run-1", status: "completed" },
		output: {
			shipped: true,
			deliverables: [
				{ id: "first", handoff: descriptor(1), checkRan: true },
				{ id: "second", handoff: descriptor(2), checkRan: true },
			],
			reviews: [
				{
					deliverable: "first",
					lens: "contracts",
					verdict: "approve",
					blocking: false,
				},
			],
			receipt: { planDigest: digest, refs: [], note: "shipped" },
		},
	};
}

/** One decided checkpoint, as the lease-free inspection carries the facts. */
function decided(value: unknown) {
	return {
		source: "human",
		decidedBy: "vegard",
		decidedAt: "2026-09-17T08:00:00.000Z",
		sha256: sha("e"),
		value,
	};
}

/** The `ship` checkpoint task, with or without a decision on it. */
function shipTask(decision?: Record<string, unknown>) {
	return {
		id: "task_ship",
		key: "ship",
		kind: "checkpoint",
		status: "completed",
		checkpoint: {
			prompt: "Ship it?",
			schema: { type: "object" },
			headless: "refuse",
			...(decision ? { decision } : {}),
		},
	};
}

/**
 * What `inspect(runId, {include: ["run","tasks","output"]})` hands back for a
 * settled run: the committed output on `run.output`, and the decided value on
 * the `ship` checkpoint task. `null` leaves the checkpoint out entirely.
 */
function runShaped(
	digest: string,
	ship: unknown = shipTask(decided({ ship: true })),
) {
	return {
		run: {
			runId: "run-1",
			status: "completed",
			definitionName: "plan-to-ship",
			output: {
				shipped: true,
				deliverables: [
					{ id: "first", handoff: descriptor(1) },
					{ id: "second", handoff: descriptor(2) },
				],
				reviews: [
					{
						deliverable: "first",
						lens: "contracts",
						verdict: "approve",
						blocking: false,
					},
				],
				receipt: { planDigest: digest },
			},
		},
		tasks: [
			{ key: "implement-first", kind: "agent", handoff: descriptor(1) },
			...(ship === null ? [] : [ship]),
		],
	};
}

/** The same output with the descriptor flattened onto the entry. */
function flattenedShaped(digest: string) {
	return {
		output: {
			deliverables: [
				{ id: "first", ...descriptor(1) },
				{ id: "second", ...descriptor(2) },
			],
			receipt: { planDigest: digest },
		},
	};
}

interface Recorder {
	readonly commands: string[];
	readonly bash: AuditedBash;
}

/** An audited Bash runner that succeeds unless a command matches `fail`. */
function recorder(fail?: RegExp, output = "boom"): Recorder {
	const commands: string[] = [];
	return {
		commands,
		bash: async (command: string) => {
			commands.push(command);
			return fail?.test(command)
				? { ok: false, output }
				: {
						ok: true,
						output: command.includes("gh pr create")
							? "https://github.com/o/r/pull/7"
							: "",
					};
		},
	};
}

interface Fake {
	readonly ui: PublishUI;
	readonly notices: { message: string; type?: string }[];
	readonly confirms: string[];
}

function ui(
	answer: boolean | ((title: string) => boolean) = true,
	choice?: string,
): Fake {
	const notices: { message: string; type?: string }[] = [];
	const confirms: string[] = [];
	return {
		notices,
		confirms,
		ui: {
			confirm: async (title) => {
				confirms.push(title);
				return typeof answer === "function" ? answer(title) : answer;
			},
			select: async () => choice,
			notify: (message, type) => {
				notices.push({ message, ...(type ? { type } : {}) });
			},
		},
	};
}

function files(seed: Record<string, string> = {}): PublishFiles & {
	readonly store: Map<string, string>;
} {
	const store = new Map(Object.entries(seed));
	return {
		store,
		exists: (path) => store.has(path),
		readText: (path) => store.get(path),
		writeText: (path, text) => {
			store.set(path, text);
		},
	};
}

/** A repository whose manifest names a check, which is the normal case. */
const checkable = () =>
	files({ [`${REPO}/package.json`]: '{"scripts":{"check":"biome"}}' });

function deps(overrides: Partial<Parameters<typeof publishPlan>[0]> = {}) {
	const document = overrides.plan ?? plan();
	const digest = planDigest(document);
	return {
		slug: "demo",
		plan: document,
		runId: "run-1",
		provider: { inspect: async () => taskShaped(digest) },
		bash: recorder().bash,
		ui: ui().ui,
		store: planStore,
		files: checkable(),
		now: () => WHEN,
		ghPresent: () => true,
		...overrides,
	};
}

// The receipt belongs beside the plan, and where the plan is is now a question
// about a project. A publication that joined its own path from `agentDir` would
// write receipts into a directory no `/plan list` ever reads again.
describe("the receipt goes under this project's plan directory", () => {
	it("asks the store rather than building the path", async () => {
		const store = checkable();
		const published = await publishPlan(deps({ files: store }));
		expect(published.ok).toBe(true);
		expect(receiptPath).toBe(
			`${AGENT_DIR}/maestro/plans/--work-demo-project--/demo/publication.json`,
		);
		expect(store.store.get(receiptPath)).toBeDefined();
	});
});

describe("readReceipt", () => {
	it("reads the digest and the handoffs off the run's committed output", () => {
		const read = readReceipt(runShaped(sha("d")));
		if (!read.ok) throw new Error(read.reason);
		expect(read.receipt.planDigest).toBe(sha("d"));
		expect(read.receipt.deliverables.map((d) => d.id)).toEqual([
			"first",
			"second",
		]);
		expect(read.receipt.reviews?.[0]?.lens).toBe("contracts");
	});

	it("prefers `run.output.receipt` over a digest hoisted anywhere else", () => {
		const inspection = {
			...runShaped(sha("d")),
			receipt: { planDigest: sha("f") },
		};
		const read = readReceipt(inspection);
		if (!read.ok) throw new Error(read.reason);
		expect(read.receipt.planDigest).toBe(sha("d"));
	});

	it("reads the handoff off the tasks of a lease-free inspection", () => {
		const read = readReceipt(taskShaped(sha("d")));
		if (!read.ok) throw new Error(read.reason);
		expect(read.receipt.planDigest).toBe(sha("d"));
		expect(read.receipt.deliverables.map((d) => d.id)).toEqual([
			"implement-first",
			"implement-second",
		]);
		expect(read.receipt.deliverables[0].subagentRunId).toBe("sr-1");
		expect(read.receipt.runCwd).toBe(REPO);
	});

	it("reads the handoff nested under a receipt entry's `handoff`", () => {
		const read = readReceipt(outputShaped(sha("d")));
		if (!read.ok) throw new Error(read.reason);
		expect(read.receipt.deliverables.map((d) => d.id)).toEqual([
			"first",
			"second",
		]);
		expect(read.receipt.reviews?.[0]).toEqual({
			deliverable: "first",
			lens: "contracts",
			verdict: "approve",
			blocking: false,
		});
	});

	it("reads the handoff flattened onto a receipt entry", () => {
		const read = readReceipt(flattenedShaped(sha("d")));
		if (!read.ok) throw new Error(read.reason);
		expect(read.receipt.deliverables.map((d) => d.handoffCommit)).toEqual([
			sha("1"),
			sha("2"),
		]);
	});

	it("refuses an inspection with no plan digest, naming the field", () => {
		const { receipt: _dropped, ...rest } = taskShaped(sha("d"));
		const read = readReceipt(rest);
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.reason).toContain("receipt.planDigest");
	});

	it("refuses an inspection with no handoff at all", () => {
		const read = readReceipt({
			receipt: { planDigest: sha("d") },
			tasks: [{ key: "refine", kind: "agent" }],
		});
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.reason).toContain("names no handoff");
	});

	it("refuses by name for every missing descriptor field", () => {
		for (const field of [
			"subagentRunId",
			"subagentAttemptId",
			"baselineHead",
			"handoffCommit",
			"sha256",
			"bytes",
		]) {
			const handoff: Record<string, unknown> = { ...descriptor(1) };
			delete handoff[field];
			const read = readReceipt({
				receipt: { planDigest: sha("d") },
				output: { deliverables: [{ id: "first", handoff }] },
			});
			expect(read.ok).toBe(false);
			if (read.ok) continue;
			expect(read.reason).toContain(`\`${field}\``);
			expect(read.reason).toContain("`first`");
		}
	});

	it("refuses a descriptor whose digests are not digests", () => {
		const read = readReceipt({
			receipt: { planDigest: sha("d") },
			output: {
				deliverables: [
					{ id: "first", handoff: { ...descriptor(1), sha256: "nope" } },
				],
			},
		});
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.reason).toContain("`sha256`");
	});

	it("names the handoff ref pi-subagent wrote", () => {
		const read = readReceipt(outputShaped(sha("d")));
		if (!read.ok) throw new Error(read.reason);
		expect(handoffRef(read.receipt.deliverables[0])).toBe(
			"refs/pi-subagent/handoffs/sr-1/at-1",
		);
	});
});

describe("shipDecision", () => {
	it("proves `{ship: true}` from the ship checkpoint's decided value", () => {
		const decision = shipDecision(runShaped(sha("d")));
		expect(decision).toEqual({
			ok: true,
			decidedBy: "vegard",
			source: "human",
			sha256: sha("e"),
		});
	});

	it("refuses an undecided ship gate, naming the run", () => {
		const decision = shipDecision(runShaped(sha("d"), shipTask()));
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.reason).toContain("`run-1`");
		expect(decision.reason).toContain("undecided");
	});

	it("refuses a gate decided `false`, quoting what it was decided", () => {
		const decision = shipDecision(
			runShaped(sha("d"), shipTask(decided({ ship: false }))),
		);
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.reason).toContain("`run-1`");
		expect(decision.reason).toContain('{"ship":false}');
	});

	it("refuses a decision whose value the runtime could not verify", () => {
		const { value: _unverified, ...rest } = decided({ ship: true });
		const decision = shipDecision(runShaped(sha("d"), shipTask(rest)));
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.reason).toContain("no verified value");
	});

	it("refuses a run that declares no ship checkpoint at all", () => {
		const decision = shipDecision(runShaped(sha("d"), null));
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.reason).toContain("no `ship` checkpoint");
	});

	it("does not mistake another checkpoint, or another task, for the gate", () => {
		const approve = {
			key: "ship",
			kind: "agent",
			checkpoint: { decision: decided({ ship: true }) },
		};
		expect(shipDecision(runShaped(sha("d"), approve)).ok).toBe(false);
		const elsewhere = {
			key: "approve-d0",
			kind: "checkpoint",
			checkpoint: { decision: decided({ ship: true }) },
		};
		expect(shipDecision(runShaped(sha("d"), elsewhere)).ok).toBe(false);
	});
});

describe("orderDeliverables", () => {
	it("puts a task-keyed receipt back into plan order", () => {
		const read = readReceipt(taskShaped(sha("d")));
		if (!read.ok) throw new Error(read.reason);
		const reversed = [...read.receipt.deliverables].reverse();
		expect(orderDeliverables(plan(), reversed).map((d) => d.id)).toEqual([
			"implement-first",
			"implement-second",
		]);
	});

	it("matches a deliverable id through a verify-and-fix task key", () => {
		const read = readReceipt({
			receipt: { planDigest: sha("d") },
			tasks: [
				{ key: "verify-second-fix-1", handoff: descriptor(2) },
				{ key: "implement-first", handoff: descriptor(1) },
			],
		});
		if (!read.ok) throw new Error(read.reason);
		expect(
			orderDeliverables(plan(), read.receipt.deliverables).map((d) => d.id),
		).toEqual(["implement-first", "verify-second-fix-1"]);
	});
});

describe("resolveHostCheck", () => {
	it("prefers the gate a repository's AGENTS.md names", () => {
		const check = resolveHostCheck(
			REPO,
			files({
				[`${REPO}/AGENTS.md`]:
					"- `npm run check` — the full gate: biome then tsc\n",
				[`${REPO}/package.json`]: '{"scripts":{"test":"vitest"}}',
			}),
		);
		expect(check).toEqual({
			command: "npm ci && npm run check",
			source: "AGENTS.md",
		});
	});

	it("falls back to the manifest, and to nothing at all", () => {
		expect(resolveHostCheck(REPO, checkable())).toEqual({
			command: "npm ci && npm run check",
			source: "package.json",
		});
		expect(
			resolveHostCheck(
				REPO,
				files({ [`${REPO}/package.json`]: '{"scripts":{"test":"v"}}' }),
			),
		).toEqual({ command: "npm ci && npm test", source: "package.json" });
		expect(resolveHostCheck(REPO, files())).toBeUndefined();
	});
});

describe("publishPlan", () => {
	it('refuses `mode: "none"` by naming the policy, and runs nothing', async () => {
		const bash = recorder();
		const reporter = ui();
		const published = await publishPlan(
			deps({ plan: plan({ mode: "none" }), bash: bash.bash, ui: reporter.ui }),
		);
		expect(published.ok).toBe(false);
		expect(published.stoppedAt).toBe("policy");
		expect(published.reason).toContain('policy.publish.mode: "none"');
		expect(bash.commands).toEqual([]);
		expect(reporter.notices[0]?.type).toBe("error");
	});

	it("asks the inspection for the run's committed output", async () => {
		const asked: unknown[] = [];
		await publishPlan(
			deps({
				provider: {
					inspect: async (_runId: string, options?: unknown) => {
						asked.push(options);
						return runShaped(planDigest(plan()));
					},
				},
			}),
		);
		expect(asked).toEqual([{ include: ["run", "tasks", "output"] }]);
	});

	it("proves the ship decision before anything runs, when nobody typed the command", async () => {
		const bash = recorder();
		const reporter = ui();
		const published = await publishPlan(
			deps({
				bash: bash.bash,
				ui: reporter.ui,
				requireShipDecision: true,
				provider: {
					inspect: async () =>
						runShaped(planDigest(plan()), shipTask(decided({ ship: false }))),
				},
			}),
		);
		expect(published.stoppedAt).toBe("decision");
		expect(published.reason).toContain("`run-1`");
		expect(bash.commands).toEqual([]);
	});

	it("publishes a proven ship decision without asking a second time", async () => {
		const reporter = ui();
		const published = await publishPlan(
			deps({
				ui: reporter.ui,
				requireShipDecision: true,
				provider: { inspect: async () => runShaped(planDigest(plan())) },
			}),
		);
		expect(published.ok).toBe(true);
		expect(reporter.confirms).toEqual(["Push and open a pull request?"]);
	});

	it("does not demand a ship gate of a publication a human asked for", async () => {
		const published = await publishPlan(
			deps({
				provider: {
					inspect: async () => runShaped(planDigest(plan()), null),
				},
			}),
		);
		expect(published.ok).toBe(true);
	});

	it("stops on a digest mismatch before running a single command", async () => {
		const bash = recorder();
		const reporter = ui();
		const published = await publishPlan(
			deps({
				bash: bash.bash,
				ui: reporter.ui,
				provider: { inspect: async () => taskShaped(sha("f")) },
			}),
		);
		expect(published.stoppedAt).toBe("digest");
		expect(published.reason).toContain(sha("f"));
		expect(bash.commands).toEqual([]);
		expect(published.branch).toBeUndefined();
	});

	it("issues exactly the expected commands, in order, and appends one receipt", async () => {
		const bash = recorder();
		const reporter = ui();
		const store = checkable();
		const published = await publishPlan(
			deps({ bash: bash.bash, ui: reporter.ui, files: store }),
		);
		expect(published.ok).toBe(true);
		expect(bash.commands).toEqual([
			`git -C ${REPO} rev-parse --verify 'refs/pi-subagent/handoffs/sr-1/at-1^{commit}'`,
			`git -C ${REPO} rev-parse --verify 'refs/pi-subagent/handoffs/sr-2/at-2^{commit}'`,
			`git -C ${REPO} switch -c ${BRANCH} main`,
			`git -C ${REPO} cherry-pick ${sha("1")}`,
			`git -C ${REPO} cherry-pick ${sha("2")}`,
			`cd ${REPO} && npm ci && npm run check`,
			`git -C ${REPO} push -u origin ${BRANCH}`,
			expect.stringContaining(
				"gh pr create --base main --title 'Demo plan' --body ",
			),
		]);
		expect(reporter.confirms).toEqual(["Push and open a pull request?"]);
		expect(published.prUrl).toBe("https://github.com/o/r/pull/7");

		const written = store.store.get(receiptPath);
		expect(written).toBeDefined();
		const entries = JSON.parse(written as string) as PublicationRecord[];
		expect(entries).toHaveLength(1);
		expect(entries[0].branch).toBe(BRANCH);
		expect(entries[0].mode).toBe("pr");
		expect(entries[0].prUrl).toBe("https://github.com/o/r/pull/7");
		expect(entries[0].planDigest).toBe(planDigest(plan()));
		expect(entries[0].deliverables.map((d) => d.ref)).toEqual([
			"refs/pi-subagent/handoffs/sr-1/at-1",
			"refs/pi-subagent/handoffs/sr-2/at-2",
		]);
	});

	it("carries the digest, every ref and sha256, and the check into the pull-request body", async () => {
		const bash = recorder();
		await publishPlan(
			deps({
				bash: bash.bash,
				provider: { inspect: async () => outputShaped(planDigest(plan())) },
			}),
		);
		const body =
			bash.commands.find((command) => command.includes("gh pr create")) ?? "";
		expect(body).toContain(planDigest(plan()));
		expect(body).toContain("refs/pi-subagent/handoffs/sr-2/at-2");
		expect(body).toContain(sha("b"));
		expect(body).toContain("npm ci && npm run check");
		expect(body).toContain("contracts: approve");
	});

	it("fetches the handoff when the run worked in another repository", async () => {
		const bash = recorder();
		const inspection = taskShaped(planDigest(plan()));
		await publishPlan(
			deps({
				bash: bash.bash,
				provider: {
					inspect: async () => ({
						...inspection,
						run: { ...inspection.run, cwd: "/elsewhere" },
					}),
				},
			}),
		);
		expect(bash.commands[0]).toBe(
			`git -C ${REPO} fetch /elsewhere refs/pi-subagent/handoffs/sr-1/at-1:refs/pi-subagent/handoffs/sr-1/at-1`,
		);
	});

	it("aborts a conflicted cherry-pick, names the deliverable, and pushes nothing", async () => {
		const bash = recorder(
			new RegExp(`cherry-pick ${sha("2")}$`),
			"CONFLICT (content)",
		);
		const reporter = ui();
		const store = checkable();
		const published = await publishPlan(
			deps({ bash: bash.bash, ui: reporter.ui, files: store }),
		);
		expect(published.ok).toBe(false);
		expect(published.stoppedAt).toBe("cherry-pick");
		expect(published.reason).toContain("implement-second");
		expect(published.branch).toBe(BRANCH);
		expect(bash.commands.at(-1)).toBe(`git -C ${REPO} cherry-pick --abort`);
		expect(bash.commands.some((command) => command.includes("push"))).toBe(
			false,
		);
		expect(store.store.get(receiptPath)).toBeUndefined();
		expect(reporter.confirms).toEqual([]);
	});

	it("stops before the push when the host check fails, and shows the tail", async () => {
		const bash = recorder(/npm run check/, "1 test failed\nsee above");
		const reporter = ui();
		const store = checkable();
		const published = await publishPlan(
			deps({ bash: bash.bash, ui: reporter.ui, files: store }),
		);
		expect(published.stoppedAt).toBe("check");
		expect(published.reason).toContain("1 test failed");
		expect(published.branch).toBe(BRANCH);
		expect(bash.commands.some((command) => command.includes("push"))).toBe(
			false,
		);
		expect(reporter.confirms).toEqual([]);
		expect(store.store.get(receiptPath)).toBeUndefined();
	});

	it("stops before the push when the repository names no check", async () => {
		const bash = recorder();
		const published = await publishPlan(
			deps({ bash: bash.bash, files: files() }),
		);
		expect(published.stoppedAt).toBe("check");
		expect(published.reason).toContain("names no check");
		expect(bash.commands.some((command) => command.includes("push"))).toBe(
			false,
		);
	});

	it("degrades `pr` to `branch` with a warning when `gh` is absent", async () => {
		const bash = recorder();
		const reporter = ui();
		const store = checkable();
		const published = await publishPlan(
			deps({
				bash: bash.bash,
				ui: reporter.ui,
				files: store,
				ghPresent: () => false,
			}),
		);
		expect(published.ok).toBe(true);
		expect(published.mode).toBe("branch");
		expect(published.prUrl).toBeUndefined();
		expect(
			bash.commands.some((command) => command.includes("gh pr create")),
		).toBe(false);
		expect(bash.commands.at(-1)).toBe(
			`git -C ${REPO} push -u origin ${BRANCH}`,
		);
		expect(reporter.notices[0]?.type).toBe("warning");
		expect(reporter.notices[0]?.message).toContain("`gh` is not on PATH");
		expect(reporter.confirms).toEqual(["Push this branch?"]);
		const entries = JSON.parse(
			store.store.get(receiptPath) as string,
		) as PublicationRecord[];
		expect(entries[0].mode).toBe("branch");
	});

	it("leaves the branch and pushes nothing when the confirmation is declined", async () => {
		const bash = recorder();
		const reporter = ui(false);
		const store = checkable();
		const published = await publishPlan(
			deps({ bash: bash.bash, ui: reporter.ui, files: store }),
		);
		expect(published.stoppedAt).toBe("confirm");
		expect(published.branch).toBe(BRANCH);
		expect(bash.commands.at(-1)).toBe(`cd ${REPO} && npm ci && npm run check`);
		expect(bash.commands.some((command) => command.includes("push"))).toBe(
			false,
		);
		expect(store.store.get(receiptPath)).toBeUndefined();
	});

	it("refuses a plan whose deliverables span two repositories", async () => {
		const spanning: Plan = {
			...plan(),
			repos: [
				{ key: "main", path: REPO },
				{ key: "other", path: "/other" },
			],
			deliverables: [
				{ id: "first", title: "First", after: [], reads: [], tasks: [] },
				{
					id: "second",
					title: "Second",
					after: [],
					reads: [],
					tasks: [],
					repo: "other",
				},
			],
		};
		const bash = recorder();
		const published = await publishPlan(
			deps({
				plan: spanning,
				bash: bash.bash,
				provider: { inspect: async () => taskShaped(planDigest(spanning)) },
			}),
		);
		expect(published.stoppedAt).toBe("policy");
		expect(published.reason).toContain("one branch in one repository");
		expect(bash.commands).toEqual([]);
	});

	it("appends a second publication and never rewrites the first", async () => {
		const store = checkable();
		const first = await publishPlan(deps({ files: store }));
		expect(first.ok).toBe(true);
		const after = new Date(2026, 8, 18, 9, 45);
		const second = await publishPlan(deps({ files: store, now: () => after }));
		expect(second.ok).toBe(true);

		const entries = JSON.parse(
			store.store.get(receiptPath) as string,
		) as PublicationRecord[];
		expect(entries).toHaveLength(2);
		expect(entries[0].branch).toBe(BRANCH);
		expect(entries[1].branch).toBe("pi-maestro/demo/20260918-0945");
		expect(entries[0].publishedAt).not.toBe(entries[1].publishedAt);
	});

	it("refuses to overwrite a publication file it cannot read", async () => {
		const store = checkable();
		store.store.set(receiptPath, "{not json");
		const published = await publishPlan(deps({ files: store }));
		expect(published.stoppedAt).toBe("record");
		expect(store.store.get(receiptPath)).toBe("{not json");
	});
});

describe("appendPublication", () => {
	const record = (branch: string): PublicationRecord => ({
		schemaVersion: 1,
		publishedAt: "2026-09-17T08:30:00.000Z",
		slug: "demo",
		runId: "run-1",
		planDigest: sha("d"),
		mode: "branch",
		base: "main",
		branch,
		check: { command: "npm test", passed: true },
		deliverables: [],
	});

	it("refuses a file that is not an array of receipts", () => {
		const store = files({ "/p.json": '{"branch":"one"}' });
		const appended = appendPublication("/p.json", record("two"), store);
		expect(appended.ok).toBe(false);
		expect(store.store.get("/p.json")).toBe('{"branch":"one"}');
	});
});

describe("shipPlan", () => {
	function page(runIds: readonly string[]) {
		return {
			runs: runIds.map((runId) => ({
				runId,
				definitionName: "plan-to-ship",
				status: "completed",
			})),
			total: runIds.length,
		};
	}

	it("refuses when no completed run carries the plan's digest", async () => {
		const reporter = ui();
		const published = await shipPlan({
			slug: "demo",
			plan: plan(),
			provider: {
				inspect: async () => taskShaped(sha("f")),
				runs: async () => page(["run-1"]),
			},
			bash: recorder().bash,
			ui: reporter.ui,
			store: planStore,
			files: checkable(),
			now: () => WHEN,
			ghPresent: () => true,
			workflowRef: "plan-to-ship",
		});
		expect(published.ok).toBe(false);
		expect(published.reason).toContain("no completed");
	});

	it("asks which run when more than one carries the digest", async () => {
		const reporter = ui(true, "run-2");
		const bash = recorder();
		const published = await shipPlan({
			slug: "demo",
			plan: plan(),
			provider: {
				inspect: async () => taskShaped(planDigest(plan())),
				runs: async () => page(["run-1", "run-2"]),
			},
			bash: bash.bash,
			ui: reporter.ui,
			store: planStore,
			files: checkable(),
			now: () => WHEN,
			ghPresent: () => true,
			workflowRef: "plan-to-ship",
		});
		expect(published.ok).toBe(true);
		expect(bash.commands.some((command) => command.includes("switch -c"))).toBe(
			true,
		);
	});
});

describe("watchShippedRuns", () => {
	function client(inspection: unknown) {
		let listener: ((observation: unknown) => void) | undefined;
		return {
			inspect: async () => inspection,
			observe: (handler: (observation: never) => void) => {
				listener = handler as (observation: unknown) => void;
				return () => {
					listener = undefined;
				};
			},
			fire: (observation: unknown) => listener?.(observation),
			listening: () => listener !== undefined,
		};
	}

	it("announces a terminal run whose ship gate proves `{ship: true}`, once", async () => {
		const fake = client(runShaped(sha("d")));
		const announced: { runId: string; planDigest: string }[] = [];
		watchShippedRuns({
			client: fake as never,
			emit: (event) => announced.push(event),
		});
		fake.fire({ runId: "run-1", status: "running", sequence: 1 });
		fake.fire({ runId: "run-1", status: "completed", sequence: 2 });
		fake.fire({ runId: "run-1", status: "completed", sequence: 3 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(announced).toEqual([{ runId: "run-1", planDigest: sha("d") }]);
	});

	it.each([
		["undecided", shipTask()],
		["decided `false`", shipTask(decided({ ship: false }))],
		["without a ship gate", null],
	])(
		"reports a run whose gate is %s by name, and announces nothing",
		async (_case, ship) => {
			const fake = client(runShaped(sha("d"), ship));
			const announced: unknown[] = [];
			const reported: string[] = [];
			watchShippedRuns({
				client: fake as never,
				emit: (event) => announced.push(event),
				report: (message) => reported.push(message),
			});
			fake.fire({ runId: "run-1", status: "completed", sequence: 2 });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(announced).toEqual([]);
			expect(reported).toHaveLength(1);
			expect(reported[0]).toContain("`run-1`");
		},
	);

	it("says nothing about a run with no readable receipt, and unsubscribes", async () => {
		const fake = client({ run: { runId: "run-1", status: "completed" } });
		const announced: unknown[] = [];
		const stop = watchShippedRuns({
			client: fake as never,
			emit: (event) => announced.push(event),
		});
		fake.fire({ runId: "run-1", status: "completed", sequence: 2 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(announced).toEqual([]);
		stop();
		expect(fake.listening()).toBe(false);
	});
});

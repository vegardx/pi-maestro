// `/plan` — the first reader the plan store ever had.
//
// Two things are being held down here. One: the grammar rejects rather than
// guesses, because a mistyped effort that silently became `standard` would
// spend (or fail to spend) a deep run's budget and nothing would say so. Two:
// `run` hands off and does not execute — it writes an input and steers the
// session, and the approval it names is a checkpoint in someone else's runtime.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	planFile,
	plansRoot,
	workflowInputFile,
} from "../packages/maestro/src/paths.js";
import type { Plan } from "../packages/maestro/src/plan.js";
import {
	PLAN_COMMAND_USAGE,
	type PlanCommandOutcome,
	parsePlanCommand,
	renderPlan,
	runPlanCommand,
} from "../packages/maestro/src/plan-command.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import type { Publication } from "../packages/maestro/src/publish.js";
import { createPlanStore } from "../packages/maestro/src/store.js";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function temp(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `maestro-${label}-`));
	dirs.push(dir);
	return dir;
}

// A plan's repo path is validated against a real Git working-tree root, so the
// fixture is a real one. A fake path would only prove validation was off.
function repo(): string {
	const dir = temp("plan-cmd-repo");
	execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
	return dir;
}

function plan(slug: string, root: string, title = `Plan ${slug}`): Plan {
	return {
		slug,
		title,
		repos: [{ key: "main", path: root }],
		deliverables: [
			{
				id: "api",
				title: "Build the API",
				after: [],
				reads: [],
				tasks: [{ id: "handler", title: "Write the handler" }],
			},
			{
				id: "ui",
				title: "Build the UI",
				body: "Talks to the API.",
				after: ["api"],
				// Not `reads: ["api"]`: a deliverable cannot build on another's
				// hand-off in the same repository yet, and the plan model refuses
				// that edge rather than compiling it and dropping it.
				reads: [],
				tasks: [
					{ id: "screen", title: "Draw the screen" },
					{
						id: "sec",
						title: "Review the surface",
						by: {
							lens: "security",
							tier: "heavy",
							diverse: true,
							model: "anthropic/claude",
						},
					},
				],
			},
		],
	};
}

interface Harness {
	readonly agentDir: string;
	readonly root: string;
	readonly store: ReturnType<typeof createPlanStore>;
	readonly steers: string[];
	readonly confirms: string[];
	readonly shipped: Plan[];
	run(
		args: string,
		options?: {
			confirm?: boolean;
			hasUI?: boolean;
			steer?: boolean;
			ship?: Publication | false;
		},
	): Promise<PlanCommandOutcome>;
}

function harness(): Harness {
	const agentDir = temp("plan-cmd-agent");
	const root = repo();
	const store = createPlanStore(plansRoot(agentDir));
	const steers: string[] = [];
	const confirms: string[] = [];
	const shipped: Plan[] = [];
	return {
		agentDir,
		root,
		store,
		steers,
		confirms,
		shipped,
		run: (args, options = {}) =>
			runPlanCommand(
				{
					store,
					inputPath: (slug) => workflowInputFile(slug, agentDir),
					...(options.steer === false
						? {}
						: { sendUserMessage: (content: string) => steers.push(content) }),
					// Absent unless the test asks for it: a seat with no workflow
					// runtime has no publication, which is its own outcome.
					...(options.ship === undefined || options.ship === false
						? {}
						: {
								ship: async (plan: Plan) => {
									shipped.push(plan);
									return options.ship as Publication;
								},
							}),
				},
				parsePlanCommand(args),
				{
					hasUI: options.hasUI ?? true,
					ui: {
						confirm: async (_title: string, message: string) => {
							confirms.push(message);
							return options.confirm ?? false;
						},
						notify: () => {},
					},
				} as never,
			),
	};
}

describe("the /plan grammar rejects rather than guesses", () => {
	it("parses each verb, and defaults the effort", () => {
		expect(parsePlanCommand("list")).toEqual({ kind: "list" });
		expect(parsePlanCommand("  show   arc ")).toEqual({
			kind: "show",
			slug: "arc",
		});
		expect(parsePlanCommand("rm arc")).toEqual({ kind: "rm", slug: "arc" });
		// No effort is not `standard`: the omission travels, so the plan's own
		// `policy.effort` is what decides.
		expect(parsePlanCommand("run arc")).toEqual({ kind: "run", slug: "arc" });
		expect(parsePlanCommand("run arc deep")).toEqual({
			kind: "run",
			slug: "arc",
			effort: "deep",
		});
	});

	it("answers a bare /plan with the grammar rather than a verb", () => {
		expect(parsePlanCommand("")).toEqual({ kind: "usage" });
	});

	it.each([
		["walk arc", "unknown subcommand"],
		["show", "exactly one slug"],
		["show a b", "exactly one slug"],
		["rm", "exactly one slug"],
		["list arc", "takes no arguments"],
		["run", "a slug and an optional effort"],
		["run arc standard extra", "a slug and an optional effort"],
		// The one that pays for the whole strictness argument.
		["run arc standrd", "unknown effort `standrd`"],
		["run arc DEEP", "unknown effort `DEEP`"],
	])("rejects `/plan %s`", (args, problem) => {
		const parsed = parsePlanCommand(args);
		expect(parsed.kind).toBe("usage");
		expect(parsed).toMatchObject({ problem: expect.stringContaining(problem) });
	});

	it("prints the grammar on every rejection", async () => {
		const h = harness();
		const outcome = await h.run("run arc standrd");
		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("unknown effort `standrd`");
		expect(outcome.message).toContain(PLAN_COMMAND_USAGE);
		// A rejected grammar touches nothing.
		expect(existsSync(workflowInputFile("arc", h.agentDir))).toBe(false);
	});
});

describe("/plan list", () => {
	it("says so when there is nothing, rather than printing a blank", async () => {
		const h = harness();
		expect((await h.run("list")).message).toContain("No stored plans");
	});

	it("names every stored plan with its title and when it was written", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root, "The arc"));
		h.store.savePlan(plan("bolt", h.root, "The bolt"));
		const message = (await h.run("list")).message;
		expect(message).toContain("2 stored plans");
		for (const [slug, title] of [
			["arc", "The arc"],
			["bolt", "The bolt"],
		]) {
			expect(message).toContain(slug);
			expect(message).toContain(title);
		}
		// The updated time is the store's `savedAt`, not a guess.
		const savedAt = h.store.list().find((s) => s.slug === "arc")?.savedAt;
		expect(savedAt).toBeTruthy();
		expect(message).toContain(savedAt as string);
		expect(message).toContain("2 deliverables");
	});
});

describe("/plan show", () => {
	it("reads the whole document back: repos, edges, work and review intent", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const message = (await h.run("show arc")).message;
		expect(message).toContain("arc — Plan arc");
		expect(message).toContain(`main  ${h.root}`);
		expect(message).toContain("api — Build the API");
		expect(message).toContain("after api");
		expect(message).toContain("- handler: Write the handler");
		expect(message).toContain(
			"- sec: Review the surface — review (lens security, tier heavy, diverse, model anthropic/claude)",
		);
	});

	it("says when a review's routing is left to the run", () => {
		const text = renderPlan({
			slug: "arc",
			title: "Arc",
			repos: [{ key: "main", path: "/somewhere" }],
			deliverables: [
				{
					id: "api",
					title: "API",
					after: [],
					reads: [],
					tasks: [{ id: "sec", title: "Review", by: { lens: "security" } }],
				},
			],
		});
		expect(text).toContain("review (lens security, effort dial decides)");
	});

	it("re-reads the world, so a tree that went dirty since is reported", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		writeFileSync(join(h.root, "scratch.txt"), "in progress\n", "utf8");
		expect((await h.run("show arc")).message).toContain("uncommitted changes");
	});

	it("names the slug it could not find", async () => {
		const h = harness();
		const outcome = await h.run("show nope");
		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("No stored plan `nope`");
		expect(outcome.message).toContain("/plan list");
	});
});

describe("/plan run hands off without executing anything", () => {
	it("writes the input beside the plan and steers the session with the call", async () => {
		const h = harness();
		const stored = plan("arc", h.root);
		h.store.savePlan(stored);
		const outcome = await h.run("run arc deep");

		const path = workflowInputFile("arc", h.agentDir);
		expect(outcome.wrote).toBe(path);
		const written = JSON.parse(readFileSync(path, "utf8"));
		expect(written.effort).toBe("deep");
		expect(written.planDigest).toBe(planDigest(stored));
		expect(written.plan).toEqual(stored);

		expect(h.steers).toHaveLength(1);
		const steer = h.steers[0];
		expect(steer).toContain('workflow_run { "ref": "plan-to-ship"');
		expect(steer).toContain('"planDigest": "');
		expect(steer).toContain(path);
		// The model is told, in the same breath, that approval is not its call.
		expect(steer).toContain("approve-plan");
		expect(steer).toMatch(/do not decide anything on my behalf/i);

		expect(outcome.message).toContain("approve-plan");
		expect(outcome.message).toContain("effort deep");
	});

	it("takes the plan's own effort when none is given", async () => {
		// `policy.effort` is a decision a human made in the plan-mode exit and
		// the digest covers it. A run started without naming an effort runs at
		// the one the document asks for, not at a default that overrides it.
		const h = harness();
		h.store.savePlan({ ...plan("arc", h.root), policy: { effort: "deep" } });
		await h.run("run arc");
		expect(
			JSON.parse(readFileSync(workflowInputFile("arc", h.agentDir), "utf8"))
				.effort,
		).toBe("deep");
	});

	it("lets a named effort override the plan's own", async () => {
		const h = harness();
		h.store.savePlan({ ...plan("arc", h.root), policy: { effort: "deep" } });
		await h.run("run arc cheap");
		expect(
			JSON.parse(readFileSync(workflowInputFile("arc", h.agentDir), "utf8"))
				.effort,
		).toBe("cheap");
	});

	it("defaults to standard when neither the command nor the plan says", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		await h.run("run arc");
		expect(
			JSON.parse(readFileSync(workflowInputFile("arc", h.agentDir), "utf8"))
				.effort,
		).toBe("standard");
	});

	it("points at the file instead of inlining an input that is too large", async () => {
		const h = harness();
		const big: Plan = {
			slug: "big",
			title: "Big",
			repos: [{ key: "main", path: h.root }],
			deliverables: Array.from({ length: 40 }, (_, i) => ({
				id: `d${i}`,
				title: `Deliverable number ${i}`,
				body: "A body long enough that forty of them do not fit in a message.",
				after: [],
				reads: [],
				tasks: [{ id: "work", title: "Do the work" }],
			})),
		};
		h.store.savePlan(big);
		await h.run("run big");
		const steer = h.steers[0];
		expect(steer).toContain(
			`"input": <the JSON in ${workflowInputFile("big", h.agentDir)}>`,
		);
		expect(steer).toContain("pass its contents verbatim");
		// The input still exists in full; only the message is short.
		expect(
			JSON.parse(readFileSync(workflowInputFile("big", h.agentDir), "utf8"))
				.plan.deliverables,
		).toHaveLength(40);
	});

	it("prints the call when the host cannot steer, rather than losing it", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("run arc", { steer: false });
		expect(h.steers).toEqual([]);
		expect(outcome.message).toContain("cannot steer");
		expect(outcome.message).toContain('workflow_run { "ref": "plan-to-ship"');
	});

	it("refuses an unknown slug without writing anything", async () => {
		const h = harness();
		const outcome = await h.run("run nope");
		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("No stored plan `nope`");
		expect(h.steers).toEqual([]);
		expect(existsSync(workflowInputFile("nope", h.agentDir))).toBe(false);
	});
});

describe("/plan rm", () => {
	it("asks first, and keeps the plan when the answer is no", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("rm arc", { confirm: false });
		expect(h.confirms[0]).toContain("arc");
		expect(outcome.message).toContain("Kept `arc`");
		expect(h.store.exists("arc")).toBe(true);
	});

	it("removes it when the answer is yes", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("rm arc", { confirm: true });
		expect(outcome.message).toContain("Removed `arc`");
		expect(h.store.exists("arc")).toBe(false);
	});

	it("refuses outright when there is no UI to confirm with", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("rm arc", { hasUI: false, confirm: true });
		expect(outcome.level).toBe("error");
		expect(outcome.message).toContain("needs a UI to confirm");
		expect(h.confirms).toEqual([]);
		expect(h.store.exists("arc")).toBe(true);
	});

	it("names the slug it could not find, and asks nothing", async () => {
		const h = harness();
		const outcome = await h.run("rm nope", { confirm: true });
		expect(outcome.message).toContain("No stored plan `nope`");
		expect(h.confirms).toEqual([]);
	});
});

describe("one path, not two", () => {
	// `paths.planFile` exists so the command, the store and any exporter agree
	// on where a plan lives. Agreement by convention is what this asserts
	// against: the store computes its own path from its root, and if the two
	// ever drift, nothing else in the suite would notice.
	it("puts a plan exactly where paths.planFile says it is", () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		expect(existsSync(planFile("arc", h.agentDir))).toBe(true);
		expect(
			JSON.parse(readFileSync(planFile("arc", h.agentDir), "utf8")).body,
		).toMatchObject({ slug: "arc" });
	});

	it("exports the workflow input into that same plan directory", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		await h.run("run arc");
		expect(workflowInputFile("arc", h.agentDir)).toBe(
			join(dirname(planFile("arc", h.agentDir)), "workflow-input.json"),
		);
	});
});

describe("/plan ship hands a stored plan to publication", () => {
	const published = (overrides: Partial<Publication> = {}): Publication => ({
		ok: true,
		commands: [],
		branch: "pi-maestro/arc/20260917-0830",
		mode: "pr",
		prUrl: "https://github.com/o/r/pull/7",
		...overrides,
	});

	it("parses the verb and refuses anything but one slug", () => {
		expect(parsePlanCommand("ship arc")).toEqual({ kind: "ship", slug: "arc" });
		expect(parsePlanCommand("ship")).toMatchObject({ kind: "usage" });
		expect(parsePlanCommand("ship arc two")).toMatchObject({ kind: "usage" });
		expect(PLAN_COMMAND_USAGE).toContain("ship <slug>");
	});

	it("says a seat with no publication cannot publish, and names the manual way", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("ship arc");
		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("workflow runtime");
		expect(h.shipped).toEqual([]);
	});

	it("refuses to publish an unknown slug without calling publication", async () => {
		const h = harness();
		const outcome = await h.run("ship nope", { ship: published() });
		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("No stored plan");
		expect(h.shipped).toEqual([]);
	});

	it("refuses in a session with no dialogs, because publication pushes", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("ship arc", {
			hasUI: false,
			ship: published(),
		});
		expect(outcome.level).toBe("error");
		expect(outcome.message).toContain("confirm");
		expect(h.shipped).toEqual([]);
	});

	it("reports the branch and the pull request it published", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("ship arc", { ship: published() });
		expect(h.shipped.map((p) => p.slug)).toEqual(["arc"]);
		expect(outcome.level).toBe("info");
		expect(outcome.message).toContain("pi-maestro/arc/20260917-0830");
		expect(outcome.message).toContain("https://github.com/o/r/pull/7");
	});

	it("names the step a stopped publication stopped at, and the branch it left", async () => {
		const h = harness();
		h.store.savePlan(plan("arc", h.root));
		const outcome = await h.run("ship arc", {
			ship: published({ ok: false, stoppedAt: "check", prUrl: undefined }),
		});
		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("`check`");
		expect(outcome.message).toContain("pi-maestro/arc/20260917-0830");
	});
});

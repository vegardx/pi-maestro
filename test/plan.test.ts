// The plan model: what was authored, validated on its own terms.
//
// The rules here are the ones the old model could not state. `after` being
// sibling-scoped meant a deliverable could not depend on anything outside its
// parent's children, which made research-before-work and review-after-a-diff
// structurally impossible. And because authored intent shared an object with
// run state, "is this plan valid" was never answerable from the plan alone.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Deliverable,
	inspectPlan,
	type Plan,
	type RepoProbe,
	type Task,
	validatePlan,
} from "../packages/maestro/src/plan.js";

// Repository paths are checked against the world, and the graph rules are not.
// A stub probe keeps every graph test free of a filesystem; the tests that are
// ABOUT the probe use real repositories, because a stubbed answer to "is this a
// Git working-tree root" would only assert that the stub was written correctly.
const cleanRepo: RepoProbe = (path) => ({
	root: path,
	resolved: path,
	dirty: false,
});

const errorsOf = (subject: Plan, probe: RepoProbe = cleanRepo): string[] =>
	validatePlan(subject, probe);

const task = (id: string, by?: Task["by"]): Task => ({
	id,
	title: `do ${id}`,
	...(by ? { by } : {}),
});

const deliverable = (
	id: string,
	over: Partial<Deliverable> = {},
): Deliverable => ({
	id,
	title: `Deliverable ${id}`,
	after: [],
	reads: [],
	tasks: [task(`${id}-1`)],
	...over,
});

const plan = (over: Partial<Plan> = {}): Plan => ({
	slug: "arc",
	title: "Arc",
	deliverables: [],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

describe("a deliverable is work, or it is nothing", () => {
	it("rejects one with no tasks", () => {
		// Legal in the old model: a support node with zero tasks rendered an
		// empty "## Focus" to a live agent that then had nothing to do.
		const errors = errorsOf(
			plan({ deliverables: [deliverable("a", { tasks: [] })] }),
		);
		expect(errors).toContainEqual(expect.stringContaining("no tasks"));
	});

	it("accepts the minimum: an id, a title, and one task", () => {
		expect(errorsOf(plan({ deliverables: [deliverable("a")] }))).toEqual([]);
	});
});

describe("waiting and reading are different things", () => {
	it("accepts waiting without reading — ordering alone is legitimate", () => {
		// "the repo must exist first" is pure ordering. It should not drag the
		// predecessor's whole hand-off into this deliverable's context.
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("setup"),
					deliverable("build", { after: ["setup"], reads: [] }),
				],
			}),
		);
		expect(errors).toEqual([]);
	});

	it("refuses reading from work it does not wait for", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("api"),
					deliverable("ui", { after: [], reads: ["api"] }),
				],
			}),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("without waiting for it"),
		);
	});

	it("names an edge that resolves to nothing", () => {
		const errors = errorsOf(
			plan({ deliverables: [deliverable("a", { after: ["ghost"] })] }),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("no such deliverable"),
		);
	});

	it("catches a deliverable waiting for itself", () => {
		const errors = errorsOf(
			plan({ deliverables: [deliverable("a", { after: ["a"] })] }),
		);
		expect(errors).toContainEqual(expect.stringContaining("waits for itself"));
	});

	it("reports a cycle once, however it is entered", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("a", { after: ["c"] }),
					deliverable("b", { after: ["a"] }),
					deliverable("c", { after: ["b"] }),
				],
			}),
		);
		const cycles = errors.filter((e) => e.startsWith("cycle:"));
		expect(cycles).toHaveLength(1);
	});
});

describe("delegated tasks are workflow-native review launches", () => {
	it("accepts the same lens assigned to more than one model", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("a", {
						tasks: [
							task("implement"),
							task("review", {
								lens: "security",
								skill: "security-review",
								model: "anthropic/opus-5",
							}),
							task("review-again", {
								lens: "security",
								model: "xai/grok-4.5",
							}),
						],
					}),
				],
			}),
		);
		expect(errors).toEqual([]);
	});
});

describe("everything wrong is reported, not just the first thing", () => {
	it("collects unrelated errors in one pass", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("a", { tasks: [], repo: "nope" }),
					deliverable("a", { after: ["ghost"] }),
				],
			}),
		);
		expect(errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("duplicate id"),
				expect.stringContaining("no tasks"),
				expect.stringContaining("unknown repo"),
				expect.stringContaining("no such deliverable"),
			]),
		);
	});
});

describe("a review names a model, a tier, or neither", () => {
	it("accepts a lens with a tier and diversity but no model", () => {
		// The point of the tier: a plan that pins `anthropic/opus-5` runs only
		// on a host that has `anthropic/opus-5`. A tier is routable anywhere.
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("a", {
						tasks: [
							task("implement"),
							task("review", {
								lens: "security",
								tier: "heavy",
								diverse: true,
							}),
						],
					}),
				],
			}),
		);
		expect(errors).toEqual([]);
	});

	it("accepts a lens with neither — the run's effort dial decides", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("a", {
						tasks: [task("implement"), task("review", { lens: "security" })],
					}),
				],
			}),
		);
		expect(errors).toEqual([]);
	});

	it("still refuses a model that is not a provider/model ID", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("a", {
						tasks: [task("review", { lens: "security", model: "opus" })],
					}),
				],
			}),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("concrete provider/model ID"),
		);
	});

	it("refuses a tier that is not one of the three", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("a", {
						// The shape a plan read back from disk can have, which the
						// type system is no help against.
						tasks: [
							task("review", {
								lens: "security",
								tier: "enormous",
							} as unknown as Task["by"]),
						],
					}),
				],
			}),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("is not a review tier"),
		);
	});
});

describe("a repository path is checked against the world", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	const temp = (label: string): string => {
		const dir = mkdtempSync(join(tmpdir(), `maestro-plan-${label}-`));
		dirs.push(dir);
		return dir;
	};

	const repo = (label: string): string => {
		const dir = temp(label);
		execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
		return dir;
	};

	const withRepo = (path: string): Plan =>
		plan({
			repos: [{ key: "main", path }],
			deliverables: [deliverable("a", { repo: "main" })],
		});

	it("accepts a working-tree root", () => {
		expect(validatePlan(withRepo(repo("root")))).toEqual([]);
	});

	it("refuses a directory that is not in a Git working tree", () => {
		expect(validatePlan(withRepo(temp("bare")))).toContainEqual(
			expect.stringContaining("is not an existing Git working-tree root"),
		);
	});

	it("refuses a path that does not exist", () => {
		expect(
			validatePlan(withRepo(join(temp("gone"), "nowhere"))),
		).toContainEqual(
			expect.stringContaining("is not an existing Git working-tree root"),
		);
	});

	it("refuses a subdirectory of a repository, and says where the root is", () => {
		// The run creates worktrees from this path. A subdirectory would resolve
		// to the same repository and then disagree with `ctx.cwd` about what the
		// tree is — cheaper to refuse than to debug once a run is approved.
		const root = repo("sub");
		const inside = join(root, "packages");
		mkdirSync(inside);
		const errors = validatePlan(withRepo(inside));
		expect(errors).toContainEqual(
			expect.stringContaining("is not a working-tree root"),
		);
	});

	it("warns about uncommitted changes without refusing the plan", () => {
		// Authoring a plan while the tree has edits in it is the normal case. A
		// store that rejected it would teach authors to stop reading the list.
		const root = repo("dirty");
		writeFileSync(join(root, "scratch.txt"), "work in progress\n", "utf8");
		const report = inspectPlan(withRepo(root));
		expect(report.errors).toEqual([]);
		expect(report.warnings).toContainEqual(
			expect.stringContaining("uncommitted changes"),
		);
	});
});

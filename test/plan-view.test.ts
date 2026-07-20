// PlanView: the one read-side plan projection (plan-schema spike PR-1).
// Defensive over parsed JSON — the plan file is the state API — and stable
// across the v1→v2 schema change: consumers render rows, never the schema.

import { planViewTasks, projectPlanView } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";

const V1_PLAN = {
	slug: "sandbox-features",
	title: "Sandbox features",
	deliverables: [
		{
			id: "add-stats",
			title: "Add statistics module",
			status: "shipped",
			branch: "feat/add-stats",
			baseSha: "6e62ff2",
			prUrl: "https://example/pr/1",
			worker: {
				mode: "full",
				model: "sit-openai/gpt-5.6-sol",
				effort: "medium",
			},
			agents: [
				{ name: "security-audit", mode: "read-only", after: ["worker"] },
			],
			tasks: [
				{ id: "t1", title: "implement", done: true },
				{ id: "post", title: "handoff", done: true, kind: "postflight" },
			],
		},
		{
			id: "advanced",
			title: "Add advanced math",
			status: "planned",
			dependsOn: ["add-stats"],
			stacked: true,
			worker: { mode: "full" },
			agents: [],
			tasks: [],
		},
	],
};

describe("projectPlanView", () => {
	it("projects a v1 plan: flat nodes at depth 0 with every asserted field", () => {
		const view = projectPlanView(V1_PLAN);
		expect(view?.slug).toBe("sandbox-features");
		expect(view?.nodes).toHaveLength(2);
		const [stats, advanced] = view?.nodes ?? [];
		expect(stats).toMatchObject({
			id: "add-stats",
			status: "shipped",
			depth: 0,
			branch: "feat/add-stats",
			baseSha: "6e62ff2",
			prUrl: "https://example/pr/1",
			workerMode: "full",
			workerModel: "sit-openai/gpt-5.6-sol",
			workerEffort: "medium",
			authoredBy: "plan",
		});
		expect(stats.agents).toEqual([
			{ name: "security-audit", mode: "read-only", after: ["worker"] },
		]);
		expect(advanced).toMatchObject({
			stacked: true,
			dependsOn: ["add-stats"],
			status: "planned",
		});
	});

	it("planViewTasks filters to gating tasks (effective kind)", () => {
		const view = projectPlanView(V1_PLAN);
		const stats = view?.nodes[0];
		expect(stats?.tasks).toHaveLength(2); // all kinds carried
		expect(planViewTasks(stats ?? ({} as never)).map((t) => t.id)).toEqual([
			"t1",
		]); // postflight excluded from checkbox rows
	});

	it("is defensive: garbage projects to undefined, bad rows are skipped", () => {
		expect(projectPlanView(null)).toBeUndefined();
		expect(projectPlanView("nope")).toBeUndefined();
		expect(projectPlanView({ notAPlan: true })).toBeUndefined();
		const view = projectPlanView({
			deliverables: [
				{ id: "ok", title: "fine", status: "active", tasks: "garbage" },
				{ title: "no id" },
				42,
			],
		});
		expect(view?.nodes).toHaveLength(1);
		expect(view?.nodes[0]).toMatchObject({ id: "ok", tasks: [] });
	});

	it("projects a v2 recursive tree depth-first with real depth (the flip)", () => {
		const view = projectPlanView({
			slug: "v2",
			nodes: [
				{
					id: "build",
					title: "Build",
					status: "active",
					branch: "feat/build",
					authoredBy: "plan",
					tasks: [{ id: "t1", title: "impl", done: false }],
					children: [
						{
							id: "cand",
							title: "Candidate",
							status: "planned",
							authoredBy: "build",
							tasks: [],
							children: [
								{
									id: "probe",
									title: "Probe",
									status: "planned",
									authoredBy: "cand",
									tasks: [],
								},
							],
						},
					],
				},
				{ id: "docs", title: "Docs", status: "planned", tasks: [] },
			],
		});
		expect(
			view?.nodes.map((n) => ({ id: n.id, depth: n.depth, by: n.authoredBy })),
		).toEqual([
			{ id: "build", depth: 0, by: "plan" },
			{ id: "cand", depth: 1, by: "build" },
			{ id: "probe", depth: 2, by: "cand" },
			{ id: "docs", depth: 0, by: "plan" },
		]);
	});
});

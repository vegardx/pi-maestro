import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildRunProjection, RunId } from "@vegardx/pi-contracts";
import { canonicalTokenSnapshot } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import { ChildProjectionStore } from "../packages/modes/src/exec/child-projections.js";
import {
	renderMaestroPrSection,
	updateMaestroPrBody,
} from "../packages/modes/src/pr-provenance.js";
import {
	HudComponent,
	type HudSnapshot,
} from "../packages/modes/src/runtime/hud.js";
import type { Deliverable } from "../packages/modes/src/schema.js";
import { UsageCheckpointStore } from "../packages/modes/src/usage-checkpoints.js";
import { UsageLedger } from "../packages/modes/src/usage-ledger.js";
import type { WorkflowAnalyticsLedger } from "../packages/modes/src/workflow-analytics.js";
import {
	runScenario,
	type ScenarioResult,
} from "./fixtures/scenario-harness.js";

const SHA = "c".repeat(40);
const results: ScenarioResult[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const result of results.splice(0)) result.cleanup();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function child(
	revision: number,
	status: ChildRunProjection["status"] = "running",
): ChildRunProjection {
	return {
		runId: "review-child" as RunId,
		revision,
		kind: "security-review",
		model: "provider/security",
		effort: "high",
		status,
		createdAt: 100,
		updatedAt: 100 + revision,
		...(status === "succeeded" ? { completedAt: 100 + revision } : {}),
		profile: { profile: "review", displayName: "security-review" },
		usage: canonicalTokenSnapshot({ input: revision * 10, output: revision }),
	};
}

function makeDelivery(analytics?: WorkflowAnalyticsLedger): Deliverable {
	return {
		type: "deliverable",
		id: "runtime",
		title: "Runtime",
		body: "Lifecycle hardening",
		status: "complete",
		worker: { mode: "full" },
		agents: [],
		tasks: [],
		...(analytics ? { workflowAnalytics: analytics } : {}),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function analytics(): WorkflowAnalyticsLedger {
	return {
		version: 1,
		deliverableId: "runtime",
		revision: 2,
		stages: [
			{
				stageId: "review",
				inputSha: SHA,
				outputSha: SHA,
				status: "succeeded",
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:01.000Z",
			},
		],
		assignments: [
			{
				assignmentId: "security",
				stageId: "review",
				kind: "security-review",
				modelId: "provider/security",
				effort: "high",
				runId: "run-security",
				inputSha: SHA,
				outputSha: SHA,
				status: "succeeded",
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:01.000Z",
				evidence: ["src/runtime.ts:42 checked", "token=do-not-publish"],
				usage: canonicalTokenSnapshot({
					input: 100,
					output: 20,
					cacheRead: 80,
					cacheWrite: 5,
					cost: 0.25,
				}),
			},
		],
		rawFindings: [],
		canonicalFindings: [],
		finalVerification: {
			assignmentId: "verify",
			modelId: "provider/verifier",
			reviewedSha: SHA,
			status: "passed",
			startedAt: "2026-01-01T00:00:01.000Z",
			completedAt: "2026-01-01T00:00:02.000Z",
			evidence: ["tests pass"],
		},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:02.000Z",
	};
}

describe("lifecycle and observability scenarios", () => {
	it("keeps start/restart orthogonal and models K failure as recoverable audited state", async () => {
		const result = await runScenario({
			name: "start restart kill recover",
			steps: [
				{
					name: "create active and planned deliveries",
					run: (scenario) => {
						const store = {
							root: join(scenario.root, "plans"),
							exists: () => false,
							load: () => null,
							save: (plan: unknown) =>
								scenario.state.set("plan", structuredClone(plan)),
							remove: () => {},
							list: () => [],
						};
						const engine = PlanEngine.create(
							store,
							{
								slug: "lifecycle",
								title: "Lifecycle",
								repoPath: scenario.repo,
							},
							scenario.clock.iso,
						);
						engine.setPhase("structuring");
						engine.addDeliverable({
							id: "active",
							title: "Active",
							workerMode: "full",
						});
						engine.addWorkItem("active", { title: "Run" });
						engine.addDeliverable({
							id: "queued",
							title: "Queued",
							workerMode: "full",
						});
						engine.addWorkItem("queued", { title: "Wait" });
						engine.setDeliverableStatus("active", "active");
						engine.updateWorkerSession("active", {
							sessionGeneration: 1,
							sessionPath: join(scenario.root, "active.jsonl"),
							sessionName: "active-worker",
							restartMode: "resume",
							restartState: "running",
						});
						scenario.emit("lifecycle.started", {
							activated: ["active"],
							untouched: ["queued"],
						});
						engine.updateWorkerSession("active", {
							sessionGeneration: 2,
							restartMode: "resume",
							restartState: "running",
						});
						scenario.emit("lifecycle.restarted", {
							id: "active",
							generation: 2,
						});
						engine.setDeliverableStatus("active", "failed", {
							code: "operator-k",
							message: "bounded shutdown requested",
							failedAt: scenario.clock.iso(),
							recoverable: true,
							attempt: 1,
							agentId: "active/worker",
						});
						scenario.emit("lifecycle.k-failed", {
							id: "active",
							recoverable: true,
						});
						engine.setDeliverableStatus("active", "active");
						scenario.emit("lifecycle.recovered", {
							scope: "targeted",
							ids: ["active"],
						});
						expect(
							engine.get().deliverables.find((item) => item.id === "queued")
								?.status,
						).toBe("planned");
					},
				},
			],
		});
		results.push(result);
		expect(result.events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"lifecycle.started",
				"lifecycle.restarted",
				"lifecycle.k-failed",
				"lifecycle.recovered",
			]),
		);
		const plan = (
			result.finalState as { state: { plan: { deliverables: Deliverable[] } } }
		).state.plan;
		expect(plan.deliverables.map(({ id, status }) => ({ id, status }))).toEqual(
			[
				{ id: "active", status: "active" },
				{ id: "queued", status: "planned" },
			],
		);
	});

	it("reconciles children by generation and restores accounting without replay double counts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lifecycle-observability-"));
		dirs.push(dir);
		const projectionsPath = join(dir, "children.json");
		const store = new ChildProjectionStore(projectionsPath);
		store.apply({
			ownerId: "runtime/worker",
			expectedGeneration: 2,
			ownerGeneration: 2,
			reconcile: true,
			runs: [child(2)],
		});
		expect(
			store.apply({
				ownerId: "runtime/worker",
				expectedGeneration: 3,
				ownerGeneration: 2,
				reconcile: false,
				runs: [child(3, "succeeded")],
			}),
		).toEqual([]);
		const restored = new ChildProjectionStore(projectionsPath);
		expect(restored.get("review-child")?.confirmed).toBe(false);
		restored.apply({
			ownerId: "runtime/worker",
			expectedGeneration: 3,
			ownerGeneration: 3,
			reconcile: true,
			runs: [child(3, "succeeded")],
		});
		expect(restored.get("review-child")).toMatchObject({
			ownerGeneration: 3,
			confirmed: true,
			projection: { status: "succeeded", revision: 3 },
		});

		const usagePath = join(dir, "usage.json");
		const checkpoints = new UsageCheckpointStore(usagePath);
		checkpoints.accept({
			source: { kind: "agent", id: "runtime/worker", generation: 1 },
			revision: 2,
			snapshot: canonicalTokenSnapshot({ input: 50, output: 5 }),
			updatedAt: 1,
		});
		checkpoints.accept({
			source: { kind: "agent", id: "runtime/worker", generation: 2 },
			revision: 1,
			snapshot: canonicalTokenSnapshot({ input: 20, output: 2 }),
			updatedAt: 2,
		});
		const ledger = new UsageLedger();
		expect(ledger.restore(new UsageCheckpointStore(usagePath).load())).toBe(2);
		expect(ledger.restore(new UsageCheckpointStore(usagePath).load())).toBe(0);
		expect(ledger.snapshot().totals).toMatchObject({
			input: 70,
			output: 7,
			totalTokens: 77,
		});
	});

	it("renders responsive HUD telemetry and marker-bounded redacted PR projection", () => {
		const snap: HudSnapshot = {
			agents: [
				{
					key: "runtime/worker",
					label: "worker · runtime",
					status: "running",
					startedAt: 1_000,
					input: 125_000,
					output: 8_000,
					cacheRead: 100_000,
					cacheWrite: 5_000,
					model: "review-model",
					effort: "high",
					targetId: "worker:runtime/worker",
					children: [],
				},
			],
			plan: undefined,
			questions: [],
		};
		const hud = new HudComponent({
			state: { focus: "agents", expanded: true },
			data: () => snap,
			actions: {
				attach: () => {},
				steer: () => {},
				interrupt: () => {},
				kill: () => {},
				answer: () => {},
			},
			now: () => 253_000,
		});
		expect(hud.render(100)[1]).toContain("↑125k ↓8k");
		expect(hud.render(58)[1]).not.toContain("review-model (high)");
		expect(hud.render(34)[1]).not.toContain("↑125k");

		const delivery = makeDelivery(analytics());
		const section = renderMaestroPrSection(delivery);
		const body = updateMaestroPrBody("User-authored intro", section);
		expect(body).toContain("User-authored intro");
		expect(body).toContain("run-security");
		expect(body).toContain(SHA.slice(0, 12));
		expect(body).not.toContain("do-not-publish");
		expect(updateMaestroPrBody(body, section)).toBe(body);
	});

	it("captures cooperative and forced stop outcomes with a single fleet artifact", async () => {
		const result = await runScenario({
			name: "cooperative and forced stop",
			steps: [
				{
					name: "stop fleet",
					run: (scenario) => {
						const agents = [
							{
								agentKey: "cooperative/worker",
								generation: 1,
								outcome: "cooperative",
							},
							{ agentKey: "forced/worker", generation: 4, outcome: "forced" },
						] as const;
						scenario.state.set("stop", {
							requestedAt: scenario.clock.now(),
							completedAt: scenario.clock.advance(5_000),
							agents,
						});
						scenario.emit("fleet.stopped", { agents });
					},
				},
			],
		});
		results.push(result);
		expect(
			(
				result.finalState as {
					state: { stop: { agents: Array<{ outcome: string }> } };
				}
			).state.stop.agents.map((agent) => agent.outcome),
		).toEqual(["cooperative", "forced"]);
		expect(
			readFileSync(join(result.artifacts, "events.jsonl"), "utf8"),
		).toContain("fleet.stopped");
	});
});

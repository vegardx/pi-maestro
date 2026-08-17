import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import {
	__resetCapabilityRegistry,
	getCapability,
	type MaestroContext,
} from "@vegardx/pi-core";
import { describe, expect, it, vi } from "vitest";
import maestroExtension from "../packages/maestro/src/extension.js";
import {
	footerUsageLabels,
	formatUsage,
} from "../packages/maestro/src/footer.js";
import { installMaestroObservability } from "../packages/maestro/src/observability.js";
import {
	UsageLedger,
	workflowTaskSnapshot,
} from "../packages/maestro/src/usage-ledger.js";

describe("workflow-cutover usage ledger", () => {
	it("derives prompt tokens and cache hit from disjoint provider buckets", () => {
		const snapshot = workflowTaskSnapshot({
			inputTokens: 100,
			outputTokens: 25,
			cacheReadInputTokens: 300,
			cacheCreationInputTokens: 100,
			costUsd: 0.2,
		});
		expect(snapshot).toMatchObject({
			input: 100,
			cacheRead: 300,
			cacheWrite: 100,
			promptTokens: 500,
			totalTokens: 525,
		});
		expect(formatUsage("All", snapshot, 0)).toBe("All ↑500 ↓25 CH 60%");
	});

	it("overwrites cumulative run-qualified leaf tasks on resume", async () => {
		let input = 10;
		const ledger = new UsageLedger({
			readWorkflowRun: async () => ({
				runId: "run-1",
				status: "running",
				tasks: [
					{
						taskId: "security",
						status: "completed",
						usage: {
							inputTokens: input,
							outputTokens: 2,
							cacheReadInputTokens: 5,
							cacheCreationInputTokens: 1,
						},
					},
				],
			}),
		});
		await ledger.ingestWorkflowRun("/state", "run-1");
		input = 20;
		await ledger.ingestWorkflowRun("/state", "run-1");
		const view = ledger.snapshot();
		expect([...view.bySource.keys()]).toEqual(["run:run-1:security"]);
		expect(view.totals.input).toBe(20);
		expect(view.totals.output).toBe(2);
	});

	it("never adds the run rollup and calls missing terminal usage unavailable", async () => {
		const ledger = new UsageLedger({
			readWorkflowRun: async () => ({
				runId: "run-2",
				status: "completed",
				// A run-level rollup could say anything; the reader contract deliberately
				// exposes tasks only, so it cannot be added on top of them.
				tasks: [
					{
						taskId: "implement",
						status: "completed",
						usage: { inputTokens: 12, outputTokens: 3 },
					},
					{ taskId: "review", status: "completed" },
				],
			}),
		});
		await expect(ledger.ingestWorkflowRun("/state", "run-2")).resolves.toBe(
			true,
		);
		const view = ledger.snapshot();
		expect(view.totals.totalTokens).toBe(15);
		expect(view.unavailableSources).toEqual(new Set(["run:run-2:review"]));
		expect(footerUsageLabels(ledger).all).toBe("All ↑12 ↓3 CH 0% +1 n/a");
	});

	it("keeps reported totals but marks a resumed task with an omitted attempt partial", async () => {
		const ledger = new UsageLedger({
			readWorkflowRun: async () => ({
				runId: "resumed",
				status: "completed",
				tasks: [
					{
						taskId: "review",
						status: "completed",
						usage: {
							inputTokens: 8,
							outputTokens: 2,
							attempts: [{ unavailable: true }, {}],
						},
					},
				],
			}),
		});
		await ledger.ingestWorkflowRun("/state", "resumed");
		expect(footerUsageLabels(ledger).all).toBe("All ↑8 ↓2 CH 0% +1 n/a");
	});

	it("tracks each workflow once and stops polling after a terminal record", async () => {
		vi.useFakeTimers();
		const read = vi.fn(async () => ({
			runId: "done",
			status: "completed",
			tasks: [],
		}));
		const ledger = new UsageLedger({
			readWorkflowRun: read,
			pollIntervalMs: 10,
		});
		ledger.trackWorkflowRun("/state", "done");
		ledger.trackWorkflowRun("/state", "done");
		await vi.advanceTimersByTimeAsync(50);
		expect(read).toHaveBeenCalledTimes(1);
		ledger.dispose();
		vi.useRealTimers();
	});
});

describe("depth-zero observability wiring", () => {
	it("registers usage through the real depth-zero extension entry", async () => {
		__resetCapabilityRegistry();
		const eventHandlers = new Map<string, Array<(...args: any[]) => void>>();
		const pi = {
			events: { emit() {}, on: () => () => {} },
			on(event: string, handler: (...args: any[]) => void) {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			},
			registerCommand() {},
			registerTool() {},
			sendUserMessage() {},
		} as unknown as ExtensionAPI;
		await maestroExtension(pi);
		expect(getCapability(CAPABILITIES.usage)).toBeInstanceOf(UsageLedger);
		for (const handler of eventHandlers.get("session_shutdown") ?? [])
			handler({});
		__resetCapabilityRegistry();
	});

	it("registers usage, captures seat events, and installs the real footer", () => {
		const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
		let footerFactory: any;
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			getThinkingLevel: () => "high",
		} as unknown as ExtensionAPI;
		let registered: unknown;
		const maestro = {
			capabilities: {
				register(id: string, value: unknown) {
					expect(id).toBe(CAPABILITIES.usage);
					registered = value;
				},
			},
		} as unknown as MaestroContext;
		const ledger = installMaestroObservability(pi, maestro, () => "auto");
		expect(registered).toBe(ledger);

		const ctx = {
			hasUI: true,
			cwd: "/repo",
			model: { id: "model-1", name: "Model One" },
			getContextUsage: () => ({
				tokens: 20,
				contextWindow: 100,
				percent: 20,
			}),
			ui: { setFooter: (factory: unknown) => (footerFactory = factory) },
		} as unknown as ExtensionContext;
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		expect(footerFactory).toBeTypeOf("function");

		for (const handler of handlers.get("turn_start") ?? []) handler({}, ctx);
		for (const handler of handlers.get("message_end") ?? [])
			handler(
				{
					message: {
						role: "assistant",
						usage: {
							input: 10,
							output: 4,
							cacheRead: 30,
							cacheWrite: 10,
							cost: { total: 0.1 },
						},
					},
				},
				ctx,
			);
		for (const handler of handlers.get("turn_end") ?? []) handler({}, ctx);
		expect(footerUsageLabels(ledger)).toEqual({
			seat: "Seat ↑50 ↓4 CH 60%",
			all: "All ↑50 ↓4 CH 60%",
		});
		const component = footerFactory(
			{ requestRender() {} },
			{
				fg: (_color: string, value: string) => value,
				bold: (value: string) => value,
			},
			{
				getGitBranch: () => "main",
				getExtensionStatuses: () => new Map(),
			},
		);
		const narrow = component.render(65)[0];
		expect(narrow).toContain("Seat ↑50 ↓4 CH 60%");
		expect(narrow).not.toContain("All ↑50 ↓4 CH 60%");
	});

	it("renders omitted seat provider usage as unavailable, never zero", () => {
		const handlers = new Map<string, Array<(event: any) => void>>();
		const pi = {
			on(event: string, handler: (event: any) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		} as unknown as ExtensionAPI;
		const maestro = {
			capabilities: { register() {} },
		} as unknown as MaestroContext;
		const ledger = installMaestroObservability(pi, maestro, () => "plan");
		for (const handler of handlers.get("turn_start") ?? []) handler({});
		for (const handler of handlers.get("message_end") ?? [])
			handler({ message: { role: "assistant" } });
		for (const handler of handlers.get("turn_end") ?? []) handler({});
		expect(footerUsageLabels(ledger)).toEqual({
			seat: "Seat n/a",
			all: "All n/a",
		});
	});
});

import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { MODE_NAMES, type ModeName } from "./mode.js";
import type { Plan } from "./plan.js";
import {
	readPublicationReceipt,
	writePublicationReceipt,
} from "./publication-receipt.js";
import { publishPlan } from "./publisher.js";
import { createSeat, type Seat } from "./seat.js";
import { compileStoredPlan, runCompiledPlan } from "./workflow/runner.js";

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
}

export function startSeat(
	pi: SeatHost,
	options: { readonly cwd?: string; readonly agentDir?: string } = {},
): { seat(): Seat; currentMode(): ModeName; executing(): boolean } {
	const cwd = options.cwd ?? process.cwd();
	let built: Seat | undefined;
	let executing = false;
	const seat = (): Seat => {
		if (built) return built;
		built = createSeat({
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
		});
		for (const tool of built.tools.definitionsFor("maestro"))
			pi.registerTool(tool);
		return built;
	};

	const compile = (plan: Plan, ctx: ExtensionCommandContext) => {
		const current = ctx.model;
		if (!current?.provider || !current.id)
			throw new Error("workflow execution needs a concrete provider/model");
		return compileStoredPlan({
			cwd,
			plan: {
				...plan,
				repos: plan.repos.map((repository) => ({
					...repository,
					path: resolve(cwd, repository.path),
				})),
			},
			model: `${current.provider}/${current.id}`,
		});
	};

	const runPlan = async (
		plan: Plan,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const compiled = compile(plan, ctx);
		const approved = await ctx.ui.confirm(
			"Run Maestro plan?",
			compiled.approvalText,
		);
		if (!approved) {
			ctx.ui.notify(`Plan \`${plan.slug}\` was not approved.`, "warning");
			return;
		}
		seat().setMode("auto");
		executing = true;
		const result = await runCompiledPlan({ cwd, compiled }).finally(() => {
			executing = false;
		});
		if (result.status === "completed")
			writePublicationReceipt(cwd, result.runId, result.compiled);
		const level = result.status === "completed" ? "info" : "warning";
		ctx.ui.notify(
			`Workflow \`${plan.slug}\` finished as ${result.status} (${result.runId}).`,
			level,
		);
	};

	pi.registerCommand("mode", {
		description: `Switch posture. /mode [${MODE_NAMES.join("|")}]`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const wanted = args.trim().toLowerCase();
			if (!wanted) {
				ctx.ui.notify(`Mode is ${seat().mode().name}.`, "info");
				return;
			}
			if (!MODE_NAMES.includes(wanted as ModeName)) {
				ctx.ui.notify(
					`Unknown mode \`${wanted}\` — one of ${MODE_NAMES.join(", ")}.`,
					"warning",
				);
				return;
			}
			if (wanted === "auto" && seat().mode().name === "plan") {
				const selected = seat().store.list()[0];
				if (!selected) {
					ctx.ui.notify("No stored plan is available.", "warning");
					return;
				}
				const plan = seat().store.loadPlan(selected.slug);
				if (!plan) throw new Error(`no stored plan named \`${selected.slug}\``);
				await runPlan(plan, ctx);
				return;
			}
			const next = seat().setMode(wanted as ModeName);
			ctx.ui.notify(
				`Mode ${next.name}: ${next.cwd === "write" ? "can write" : "read-only"}, safeguards ${next.safeguards}.`,
				"info",
			);
		},
	});

	pi.registerCommand("run", {
		description: "Run a stored plan through pi-workflow. /run <slug>.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const slug = args.trim();
				if (!slug) {
					const plans = seat().store.list();
					ctx.ui.notify(
						plans.length === 0
							? "No plans stored yet."
							: plans.map((plan) => `${plan.slug} — ${plan.title}`).join("\n"),
						"info",
					);
					return;
				}
				const plan = seat().store.loadPlan(slug);
				if (!plan) throw new Error(`no stored plan named \`${slug}\``);
				await runPlan(plan, ctx);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	pi.registerCommand("publish", {
		description: "Push committed plan branches and create/update PRs.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const slug = args.trim();
				if (!slug) throw new Error("usage: /publish <plan-slug>");
				const plan = seat().store.loadPlan(slug);
				if (!plan) throw new Error(`no stored plan named \`${slug}\``);
				const receipt = readPublicationReceipt(cwd, slug);
				if (!receipt)
					throw new Error(
						`plan \`${slug}\` has no completed workflow receipt to publish`,
					);
				const approved = await ctx.ui.confirm(
					"Publish Maestro plan?",
					`Push committed branches and create or update pull requests for \`${slug}\`?`,
				);
				if (!approved) return;
				const published = await publishPlan({
					plan,
					repositories: receipt.repositories,
				});
				ctx.ui.notify(
					published.map(({ key, url }) => `${key}: ${url}`).join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	return {
		seat,
		currentMode: () => built?.mode().name ?? "plan",
		executing: () => executing,
	};
}

export default defineExtension(
	{
		name: "maestro",
		path: "packages/maestro/src/extension.ts",
		doc: "Compile plans to pi-workflow and publish committed branches.",
	},
	async (pi, maestro) => {
		const entry = startSeat(pi);
		maestro.capabilities.register(CAPABILITIES.modes, {
			current: entry.currentMode,
			onChange: (listener) => entry.seat().onModeChange(listener),
			execution: () => ({
				mode: entry.currentMode(),
				executing: entry.executing(),
				compactionInFlight: false,
			}),
		});
		const { installMaestroObservability } = await import("./observability.js");
		installMaestroObservability(pi, entry.currentMode);
	},
);

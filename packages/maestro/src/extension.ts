// The extension entry.
//
// One process runs either a maestro or a worker, and which one is decided here,
// from the environment, once. The old system had a `disableExtensions` env kill
// switch for this: a child was told which parts of its parent to switch off,
// which meant the parent had to remember to tell it, and a forgotten entry gave
// a worker the maestro's whole surface. Here the surface is not switched off —
// it is never registered, because this process knows what it is.
//
// That makes one guard structural rather than remembered. `/mode` used to need
// an operator-only check so a spawned agent could not widen its own posture;
// now an agent process never registers the command at all.
//
// Registration is synchronous and the connection is not. Tools go in at load
// time, before pi has finished starting, and the link resolves behind them; a
// tool called before the handshake completes says so, instead of hanging.

import { fileURLToPath } from "node:url";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { PersonaCatalogue } from "./agent.js";
import {
	type AgentWiring,
	createAskTransport,
	declareAgentTools,
	dialHome,
	type Reporter,
	readWiring,
} from "./agent-runtime.js";
import { createBashTool } from "./bash-tool.js";
import { createCommitTool } from "./commit-tool.js";
import { readExecutionPolicySettings } from "./execution-policy.js";
import type { AgentLink } from "./link.js";
import { MODE_NAMES, type ModeName, mode, modeForChild } from "./mode.js";
import { routeModel, routeSpread } from "./model-routing.js";
import { BUILT_IN_PERSONAS } from "./personas.js";
import {
	createReadOnlySessionFactory,
	type ReadOnlyLaunchOptions,
} from "./read-only-session.js";
import { createSeat, type Seat } from "./seat.js";
import { currentDepth } from "./spawn.js";
import { ToolRegistry } from "./tool-registry.js";
import { resolveBase } from "./workspace.js";

/** This file, so a spawned agent loads the same code its maestro is running. */
export function extensionPath(): string {
	return fileURLToPath(import.meta.url);
}

/**
 * Register the agent surface and start dialling home.
 *
 * Exported so a test can hand it a fake `pi` — the alternative is asserting on
 * a module's load-time side effects, which is how an entry point becomes the
 * thing nobody dares change.
 */
export function startWorker(
	pi: { registerTool(tool: unknown): void },
	wiring: AgentWiring,
	launch: ReadOnlyLaunchOptions,
	capabilities?: {
		register(id: typeof CAPABILITIES.askTransport, value: unknown): unknown;
	},
): Promise<AgentLink> {
	let link: AgentLink | undefined;
	let personas: PersonaCatalogue | undefined;

	const reporter = (): Reporter => {
		if (!link)
			throw new Error(
				"not connected to maestro yet — the handshake has not completed",
			);
		return link;
	};

	const registry: ToolRegistry = ToolRegistry.declare(
		declareAgentTools({
			// No `confirm`: an agent runs unattended, so a command that needs a
			// human is refused rather than left prompting into a void.
			bash: createBashTool({
				holder: "worker",
				cwd: process.cwd(),
				// A worker is never in hack — safeguards do not propagate — so its
				// posture is fixed at the one `modeForChild` gives it.
				mode: () => modeForChild(mode("auto"), "worker"),
				policy: () => readExecutionPolicySettings(process.cwd()),
			}),
			// The other half of the shell decision. A worker commits through this
			// and never through bash: its branch ref lives in the SHARED git dir,
			// which the write profile denies — rightly, since a worker rewriting
			// branches that are not its own is what that deny is for.
			commit: createCommitTool({ cwd: () => process.cwd() }),
			reporter,
			delegate: {
				cwd: () => process.cwd(),
				depth: () => wiring.depth,
				openSession: createReadOnlySessionFactory(launch),
				// A reader spawned by a worker inherits the worker's model unless a
				// roster says otherwise, and fans out across families when asked.
				route: (agent, fanOut, ctx) =>
					fanOut
						? routeSpread(ctx as ExtensionContext, agent)
						: routeModel(ctx as ExtensionContext, agent).then((one) =>
								one ? [one] : [],
							),
				// THE SAME personas the maestro declares. A worker delegating a
				// review has to hand over the real review persona — the prose that
				// says what to look for — not a sentence this file made up about
				// one. Declared lazily only because the registry it validates
				// against is the one being built here.
				briefFor: (agent, persona) => {
					personas ??= PersonaCatalogue.declare(BUILT_IN_PERSONAS, registry);
					const found = personas.require(persona);
					if (found.kind !== agent)
						throw new Error(
							`persona \`${persona}\` is for a ${found.kind}, not a ${agent}`,
						);
					return `${found.prose}\n\n${registry.describeFor("read-only")}`;
				},
			},
		}),
	);

	// A worker holds worker tools. There is no list to keep in step with this
	// one — the holder is the whole selector.
	for (const tool of registry.definitionsFor("worker")) pi.registerTool(tool);

	// `ask.v1` routes through whatever transport is registered. Registering one
	// here is the whole of "a worker's question goes to its maestro" — the agent
	// calls the same `ask` a maestro does, and position decides the destination.
	// Registered before the handshake completes, like the tools, and it says so
	// if called too early rather than hanging.
	capabilities?.register(CAPABILITIES.askTransport, {
		present: (questions: Questionnaire) =>
			createAskTransport(() => {
				if (!link)
					throw new Error("cannot ask yet — the handshake has not completed");
				return link;
			}).present(questions),
	});

	return dialHome(wiring).then((connected) => {
		link = connected;
		connected.status("working");
		return connected;
	});
}

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
	sendUserMessage(text: string, opts?: unknown): unknown;
}

/** The slice of `ask.v1` the seat uses: one blocking question, one answer. */
export interface HumanAsker {
	ask(questions: Questionnaire): Promise<Answers>;
}

/**
 * Put one question to the human, and report who actually answered.
 *
 * `ask.v1` has an idle autopilot whose answers carry `source: "maestro-auto"`,
 * and a blocking question can be deferred. Both come back as an answer, and
 * neither is a human ruling — so the attribution is read off the answer rather
 * than assumed from the fact that we asked.
 */
export function askThroughCapability(asker: HumanAsker): (
	question: string,
) => Promise<{
	readonly answer: string;
	readonly from: "maestro" | "human";
}> {
	return async (question) => {
		const answers = await asker.ask([
			{ id: "maestro", question, allowFreeText: true, blocking: true },
		]);
		const answer = answers[0];
		if (!answer || answer.deferred || answer.skipped || !answer.value.trim())
			return {
				answer:
					"nobody answered this. Decide for yourself and say in your hand-off what you assumed.",
				from: "maestro",
			};
		return {
			answer: answer.value,
			from: answer.source === "human" ? "human" : "maestro",
		};
	};
}

/**
 * Register the seat: its tools, and the two commands a human drives it with.
 *
 * The seat is built on first use, not at load. Constructing it reads the
 * repository to find a base branch, and an extension that does that at load
 * time is an extension that fails to load outside a repository.
 */
export function startSeat(
	pi: SeatHost,
	options: { readonly cwd?: string; readonly asker?: HumanAsker } = {},
): { seat(): Seat } {
	const cwd = options.cwd ?? process.cwd();
	let built: Seat | undefined;

	const seat = (): Seat => {
		if (built) return built;
		const base = resolveBase(cwd);
		if (!base)
			throw new Error(
				`cannot tell what to branch from in ${cwd}: it has no remote default branch and nothing checked out`,
			);
		built = createSeat({
			narrator: {
				// Narration reaches the maestro's own model as a follow-up. That is
				// also how it learns what its fleet did — there is no HUD, and a
				// seat that cannot see its workers cannot answer for them.
				say: (line) =>
					pi.sendUserMessage(`[maestro] ${line}`, { deliverAs: "followUp" }),
				ask: (prompt) => pi.sendUserMessage(prompt, { deliverAs: "followUp" }),
			},
			extensions: [extensionPath()],
			base,
			// The hook that was declared and never supplied. Without it the seat
			// told itself there was nobody to ask, which was false — it has a
			// human, and a worker's escalated question had nowhere to go.
			...(options.asker
				? { askHuman: askThroughCapability(options.asker) }
				: {}),
		});
		for (const tool of built.tools.definitionsFor("maestro"))
			pi.registerTool(tool);
		return built;
	};

	pi.registerCommand("mode", {
		description: `Switch posture. /mode [${MODE_NAMES.join("|")}]`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const wanted = args.trim().toLowerCase();
			if (!wanted) {
				ctx.ui.notify(`Mode is ${seat().runtime.mode().name}.`, "info");
				return;
			}
			if (!MODE_NAMES.includes(wanted as ModeName)) {
				ctx.ui.notify(
					`Unknown mode \`${wanted}\` — one of ${MODE_NAMES.join(", ")}.`,
					"warning",
				);
				return;
			}
			const mode = seat().setMode(wanted as ModeName);
			ctx.ui.notify(
				`Mode ${mode.name}: ${mode.cwd === "write" ? "can write" : "read-only"}, safeguards ${mode.safeguards}.`,
				"info",
			);
		},
	});

	pi.registerCommand("run", {
		description: "Run a stored plan. /run <slug>, or /run to list them.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const slug = args.trim();
			try {
				if (!slug) {
					const plans = seat().store.list();
					ctx.ui.notify(
						plans.length === 0
							? "No plans stored yet."
							: plans
									.map((p) => `${p.slug} — ${p.title} (${p.deliverables})`)
									.join("\n"),
						"info",
					);
					return;
				}
				await seat().run(slug, ctx as unknown as ExtensionContext);
			} catch (error) {
				// Refusals here are ordinary and legible — no such plan, plan mode
				// cannot run one, a plan already running. They belong in front of
				// the human, not in a stack trace.
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	pi.registerCommand("stop", {
		description: "Halt the running plan. /stop [why]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const reason = args.trim() || "stopped from the seat";
			try {
				const run = await seat().runtime.stop(reason);
				ctx.ui.notify(
					run
						? `Stopped \`${run.slug}\`. Run it again to pick up where it left off.`
						: "No plan is running.",
					run ? "info" : "warning",
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	return { seat };
}

export default defineExtension(
	{
		name: "maestro",
		path: "packages/maestro/src/extension.ts",
		doc: "Plans as a DAG of deliverables, workers that build them, and the maestro that owns both ends.",
	},
	(pi, maestro) => {
		// DEPTH decides, not the presence of wiring. A read-only agent is spawned
		// with a depth and deliberately WITHOUT a socket or token — it has nobody
		// to dial — so "no wiring" and "this is the seat" are not the same thing.
		// Reading them as the same gave every reviewer the maestro's own surface,
		// commands and all.
		if (currentDepth() > 0) {
			const wiring = readWiring();
			// A worker dials home; a read-only agent answers its caller and holds
			// no agent surface of its own beyond what it was launched with.
			if (wiring)
				void startWorker(
					pi,
					wiring,
					{ extensions: [extensionPath()] },
					maestro.capabilities,
				);
			return;
		}
		const asker = maestro.capabilities.get(CAPABILITIES.ask) as
			| HumanAsker
			| undefined;
		startSeat(pi, ...(asker ? [{ asker }] : []));
	},
);

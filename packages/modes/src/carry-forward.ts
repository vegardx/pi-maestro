// The carry-forward curation engine — one episode, two sinks.
//
//   /distill  → in-place curated compaction (same plan, same session)
//   /handoff  → close the arc; seed a NEW planning session (no active plan)
//
// The episode: mechanical inventory (code-harvested, always carried) →
// the model proposes narrative threads (recall + transcript archaeology) →
// multi-select curation (native Question.multiple; self-curated only when
// the 50% force fires with no human engaged) → written thread blocks →
// document persisted to <planDir>/handoffs/NN-<kind>.md → the sink runs.
//
// The `carryforward` tool is EPISODE-SCOPED: registered once, visible only
// while an episode is active (applyTools flag) — no standing prompt clutter,
// no chance of a model-initiated handoff.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AskCapabilityV1 } from "@vegardx/pi-contracts";
import type { Plan } from "./schema.js";
import { renderCollapsedResult } from "./tool-render.js";

// ─── Episode state ───────────────────────────────────────────────────────────

export type CarryKind = "distill" | "handoff";

export interface CarryTopic {
	readonly id: string;
	readonly title: string;
	readonly oneLiner: string;
	/** Where it came from: the maestro's recall or the transcript archaeologist. */
	readonly source: "recall" | "transcript";
	/** The maestro recommends carrying this one (pre-checked in the ask). */
	readonly rec?: boolean;
}

export interface CarryThread {
	readonly id: string;
	readonly title: string;
	readonly body: string;
}

/** The sink runs after the document is written: compaction or new session. */
export type CarrySink = (
	doc: string,
	path: string,
	ctx: ExtensionContext,
) => Promise<string>;

export interface CarryEpisode {
	readonly kind: CarryKind;
	/** Forced path: skip the ask, carry the maestro's own [rec] topics. */
	readonly selfCurate: boolean;
	/** Set when the 50% divergence check found drift (carried as context). */
	readonly divergenceNote?: string;
	readonly sink: CarrySink;
	topics?: CarryTopic[];
	selected?: string[];
}

/** One episode at a time; owned by the runtime, driven by the tool. */
export class CarryForwardController {
	private episode: CarryEpisode | undefined;
	/** Fires on begin/end so the runtime can re-apply the tool policy. */
	constructor(private readonly onActiveChanged?: () => void) {}

	begin(episode: CarryEpisode): boolean {
		if (this.episode) return false;
		this.episode = episode;
		this.onActiveChanged?.();
		return true;
	}

	get(): CarryEpisode | undefined {
		return this.episode;
	}

	end(): void {
		if (!this.episode) return;
		this.episode = undefined;
		this.onActiveChanged?.();
	}
}

// ─── Mechanical inventory ────────────────────────────────────────────────────

export interface InventoryDeps {
	readonly plan?: Plan;
	readonly mode: string;
	/** Adapter snapshot slices (live workers + blocked reasons). */
	readonly workers?: ReadonlyArray<{ agent: string; status: string }>;
	readonly blocked?: ReadonlyArray<{ id: string; reason: string }>;
	readonly pendingAsks?: ReadonlyArray<{ question: string }>;
	readonly planDir?: string;
	/** Injectable for tests. */
	readonly listDir?: (path: string) => string[];
}

const listDirSafe = (path: string): string[] => {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
};

/**
 * The code-harvested state block — always carried, never curated. Facts the
 * next context must not get wrong: statuses, gates, pending questions, and
 * the on-disk refs that make rehydration cheap after the cut.
 */
export function harvestInventory(deps: InventoryDeps): string {
	const lines: string[] = [];
	const list = deps.listDir ?? listDirSafe;
	if (deps.plan) {
		const p = deps.plan;
		lines.push(
			`Plan: ${p.slug} — ${p.title} (mode: ${deps.mode}${p.phase ? `, phase: ${p.phase}` : ""})`,
		);
		for (const d of p.deliverables) {
			const tasks = d.tasks.filter((t) => t.kind === "task");
			const done = tasks.filter((t) => t.done).length;
			const parts = [`- ${d.id} [${d.status}]`];
			if (tasks.length > 0) parts.push(`tasks ${done}/${tasks.length}`);
			const blocked = deps.blocked?.find((b) => b.id === d.id);
			if (blocked) parts.push(`BLOCKED: ${blocked.reason}`);
			if (d.prUrl) parts.push(d.prUrl);
			lines.push(parts.join(" · "));
		}
	} else {
		lines.push(`No active plan (mode: ${deps.mode}).`);
	}
	const working = (deps.workers ?? []).filter((w) => w.status === "working");
	if (working.length > 0) {
		lines.push(
			`Live workers: ${working.map((w) => w.agent).join(", ")} (a fresh session resumes them with /recover)`,
		);
	}
	if (deps.pendingAsks?.length) {
		lines.push(
			`Unanswered questions (${deps.pendingAsks.length}):`,
			...deps.pendingAsks.map((q) => `- ${q.question}`),
		);
	}
	if (deps.planDir) {
		const research = list(join(deps.planDir, "research")).filter((f) =>
			f.endsWith(".md"),
		);
		if (research.length > 0) {
			lines.push(
				`Research on disk (${research.length} reports — rehydrate with dig(ref)): ${research
					.map((f) => f.replace(/\.md$/, ""))
					.join(", ")}`,
			);
		}
		const rounds = list(join(deps.planDir, "verification")).filter((f) =>
			f.endsWith(".md"),
		);
		if (rounds.length > 0) {
			lines.push(`Verification rounds on disk: ${rounds.join(", ")}`);
		}
	}
	return lines.join("\n");
}

// ─── Document assembly + persistence ─────────────────────────────────────────

export function assembleCarryDocument(opts: {
	kind: CarryKind;
	inventory: string;
	threads: readonly CarryThread[];
	radar: readonly CarryTopic[];
	now: string;
	planSlug?: string;
	divergenceNote?: string;
}): string {
	const head =
		opts.kind === "distill"
			? `# Distilled context — ${opts.now}\n\nThis summary REPLACES the earlier conversation. The state below is authoritative; research reports rehydrate on demand via dig(ref); prior carry-forward documents live under the plan's handoffs/ directory.`
			: `# Handoff seed — ${opts.now}\n\nCONTEXT ONLY — raw material for forming the NEXT plan; do not act on it until asked. The previous arc is closed${opts.planSlug ? `; its plan \`${opts.planSlug}\` remains loadable via /plan ${opts.planSlug}` : ""}.`;
	const sections = [head];
	if (opts.divergenceNote) {
		sections.push(`## Divergence note\n${opts.divergenceNote}`);
	}
	sections.push(`## State\n${opts.inventory}`);
	if (opts.threads.length > 0) {
		sections.push(
			`## Threads\n${opts.threads.map((t) => `### ${t.title}\n${t.body}`).join("\n\n")}`,
		);
	}
	if (opts.radar.length > 0) {
		sections.push(
			`## Also on the radar\n${opts.radar.map((t) => `- ${t.title} — ${t.oneLiner}`).join("\n")}`,
		);
	}
	return sections.join("\n\n");
}

/** Persist under <planDir>/handoffs/NN-<kind>.md; numbering continues on disk. */
export function writeCarryDocument(
	planDir: string,
	kind: CarryKind,
	content: string,
): string {
	const dir = join(planDir, "handoffs");
	mkdirSync(dir, { recursive: true });
	let max = 0;
	if (existsSync(dir)) {
		for (const f of readdirSync(dir)) {
			const m = f.match(/^(\d+)-/);
			if (m) max = Math.max(max, Number.parseInt(m[1], 10));
		}
	}
	const path = join(dir, `${String(max + 1).padStart(2, "0")}-${kind}.md`);
	writeFileSync(path, content, "utf8");
	return path;
}

// ─── Transcript digest (the archaeologist's mechanical pre-pass) ─────────────

/** Loose entry shape — matches pi SessionEntry without importing its types. */
interface DigestibleEntry {
	readonly type?: string;
	readonly message?: {
		readonly role?: string;
		readonly content?: unknown;
	};
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(c): c is { type: string; text?: string; name?: string } =>
					!!c && typeof c === "object",
			)
			.map((c) =>
				c.type === "text"
					? (c.text ?? "")
					: c.type === "toolCall"
						? `[tool:${c.name ?? "?"}]`
						: "",
			)
			.filter(Boolean)
			.join(" ");
	}
	return "";
};

const clip = (s: string, n: number): string =>
	s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

const DIGEST_CAP = 40_000;

/**
 * The archaeologist's raw material: every user message (they carry the asks
 * and pivots), assistant first-paragraphs + tool names (they show what was
 * actually done). The go-rewrite session's user messages were 0.08MB of a
 * 6.8MB transcript — this digest keeps archaeology affordable.
 */
export function buildTranscriptDigest(
	entries: readonly DigestibleEntry[],
): string {
	const lines: string[] = [];
	for (const e of entries) {
		const m = e.message;
		if (!m?.role) continue;
		const text = textOf(m.content).replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (m.role === "user") {
			lines.push(`USER: ${clip(text, 500)}`);
		} else if (m.role === "assistant") {
			lines.push(`ASSISTANT: ${clip(text, 260)}`);
		}
	}
	const joined = lines.join("\n");
	if (joined.length <= DIGEST_CAP) return joined;
	// Keep both ends — the founding intent AND the recent drift matter most.
	const half = DIGEST_CAP / 2;
	return `${joined.slice(0, half)}\n[… middle elided …]\n${joined.slice(-half)}`;
}

// ─── The episode-scoped tool ─────────────────────────────────────────────────

export interface CarryForwardToolDeps {
	readonly controller: () => CarryForwardController;
	readonly ask: () => AskCapabilityV1 | undefined;
	readonly inventory: () => string;
	readonly planDir: () => string | undefined;
	readonly planSlug: () => string | undefined;
	readonly now?: () => string;
}

const TopicParam = Type.Object({
	id: Type.String({ description: "Short kebab id, stable within the episode" }),
	title: Type.String(),
	oneLiner: Type.String({ description: "Why it might matter, one line" }),
	source: Type.Optional(
		Type.Union([Type.Literal("recall"), Type.Literal("transcript")], {
			description:
				"recall: from your own memory of the session. transcript: from the archaeologist's findings.",
		}),
	),
	rec: Type.Optional(
		Type.Boolean({ description: "You recommend carrying this thread" }),
	),
});

const ThreadParam = Type.Object({
	id: Type.String({ description: "A selected topic id" }),
	title: Type.String(),
	body: Type.String({
		description:
			"The full thread block: decisions made, current state, and the " +
			"concrete next step. Written for a reader with NO other context.",
	}),
});

const CarryParams = Type.Object({
	action: Type.Union([Type.Literal("propose"), Type.Literal("write")]),
	topics: Type.Optional(
		Type.Array(TopicParam, {
			description: "propose: 3-10 candidate threads, most important first",
		}),
	),
	threads: Type.Optional(
		Type.Array(ThreadParam, {
			description: "write: one full block per SELECTED topic id",
		}),
	),
});

type Result = AgentToolResult<Record<string, never>>;
const text = (t: string): Result => ({
	content: [{ type: "text", text: t }],
	details: {},
});

export function createCarryForwardTool(
	deps: CarryForwardToolDeps,
): ToolDefinition {
	return defineTool({
		name: "carryforward",
		label: "Carry forward",
		description:
			"Drive the active carry-forward episode (/distill or /handoff). " +
			"propose: list candidate threads (the human curates via multi-select, " +
			"or your [rec] picks carry when forced). write: the full block per " +
			"selected topic; the harness assembles the document, persists it, and " +
			"runs the sink (compaction or new-session seed).",
		promptSnippet:
			"carryforward — propose candidate threads, then write the selected ones.",
		parameters: CarryParams,
		renderResult: renderCollapsedResult,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Result> {
			const controller = deps.controller();
			const episode = controller.get();
			if (!episode) {
				return text(
					"No carry-forward episode is active — the human starts one with /distill or /handoff.",
				);
			}
			if (params.action === "propose") {
				return await propose(episode, params.topics ?? [], deps);
			}
			return await write(controller, episode, params.threads ?? [], deps, ctx);
		},
	}) as ToolDefinition;
}

async function propose(
	episode: CarryEpisode,
	rawTopics: ReadonlyArray<{
		id: string;
		title: string;
		oneLiner: string;
		source?: "recall" | "transcript";
		rec?: boolean;
	}>,
	deps: CarryForwardToolDeps,
): Promise<Result> {
	if (rawTopics.length === 0) {
		return text("propose needs topics — 3-10 candidate threads.");
	}
	const topics: CarryTopic[] = rawTopics.map((t) => ({
		...t,
		source: t.source ?? "recall",
	}));
	episode.topics = topics;

	if (episode.selfCurate) {
		const recs = topics.filter((t) => t.rec).map((t) => t.id);
		episode.selected = recs.length > 0 ? recs : topics.map((t) => t.id);
		return text(
			`Forced episode — your recommendations carry: ${episode.selected.join(", ")}. ` +
				`Now call carryforward({action: "write", threads: [...]}) with one full block per id.`,
		);
	}

	const ask = deps.ask();
	if (!ask) {
		// No ask surface (headless) — degrade to self-curation.
		episode.selected = topics.map((t) => t.id);
		return text(
			`Ask surface unavailable — carrying all topics: ${episode.selected.join(", ")}. Call carryforward({action: "write", ...}).`,
		);
	}
	const verb =
		episode.kind === "distill"
			? "must survive the cut"
			: "carry into the next plan";
	const answers = await ask.ask([
		{
			id: "carry:select",
			question: `Carry-forward — which threads ${verb}?`,
			header: episode.kind,
			multiple: true,
			blocking: true,
			whyBlocking:
				"The carry-forward document is being written now; unselected threads degrade to one-liners.",
			options: topics.map((t) => ({
				value: t.id,
				label: `${t.title} — ${t.oneLiner} [${t.source}]`,
			})),
			...(topics.find((t) => t.rec)
				? { recommendation: topics.find((t) => t.rec)?.id }
				: {}),
		},
	]);
	const selected = answers
		.filter((a) => a.questionId === "carry:select" && a.value && !a.deferred)
		.map((a) => a.value);
	if (selected.length === 0) {
		// Deferred or nothing picked: carry the recommendations rather than
		// dropping every thread on the floor.
		const recs = topics.filter((t) => t.rec).map((t) => t.id);
		episode.selected = recs.length > 0 ? recs : topics.map((t) => t.id);
		return text(
			`No selection arrived — defaulting to: ${episode.selected.join(", ")}. Call carryforward({action: "write", ...}).`,
		);
	}
	episode.selected = selected;
	return text(
		`Selected: ${selected.join(", ")}. Now call carryforward({action: "write", threads: [...]}) — one full block per selected id (decisions, state, next step; assume the reader has NO other context).`,
	);
}

async function write(
	controller: CarryForwardController,
	episode: CarryEpisode,
	threads: readonly CarryThread[],
	deps: CarryForwardToolDeps,
	ctx: ExtensionContext,
): Promise<Result> {
	if (!episode.topics || !episode.selected) {
		return text(
			"Propose first — carryforward({action: 'propose', topics: [...]}).",
		);
	}
	const selected = new Set(episode.selected);
	const unknown = threads.filter((t) => !selected.has(t.id));
	const missing = [...selected].filter(
		(id) => !threads.some((t) => t.id === id),
	);
	if (unknown.length > 0 || missing.length > 0) {
		const parts: string[] = [];
		if (missing.length > 0)
			parts.push(`missing threads for: ${missing.join(", ")}`);
		if (unknown.length > 0)
			parts.push(
				`threads for unselected ids: ${unknown.map((t) => t.id).join(", ")}`,
			);
		return text(`write rejected — ${parts.join("; ")}.`);
	}
	const radar = episode.topics.filter((t) => !selected.has(t.id));
	const now = deps.now ? deps.now() : new Date().toISOString();
	const doc = assembleCarryDocument({
		kind: episode.kind,
		inventory: deps.inventory(),
		threads,
		radar,
		now,
		planSlug: deps.planSlug(),
		divergenceNote: episode.divergenceNote,
	});
	const planDir = deps.planDir();
	const path = planDir
		? writeCarryDocument(planDir, episode.kind, doc)
		: "(no plan dir — document not persisted)";
	// End the episode BEFORE the sink: a distill sink compacts this session,
	// and the tool must already be out of the active set when that lands.
	controller.end();
	try {
		const outcome = await episode.sink(doc, path, ctx);
		return text(outcome);
	} catch (err) {
		return text(
			`Document written to ${path}, but the ${episode.kind} sink failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

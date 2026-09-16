// Publication: turning a run's receipt into a branch, and maybe a pull request.
//
// This is the one place in the stack that PUSHES. The workflow runtime never
// does (`pi-workflow/docs/authority.md`): it ends at a handoff commit in the
// publication repository's own object store, named by
// `refs/pi-subagent/handoffs/<subagentRunId>/<subagentAttemptId>`, and stops.
// Everything after that is this file, under pi-maestro's own audited Bash
// policy, authorized by a durable human decision.
//
// Three properties hold the whole thing up:
//
// 1. **The digest is checked first.** A receipt whose `planDigest` is not the
//    stored plan's names bytes nobody approved now, so the flow refuses before
//    it runs a single command. It is the cheapest check and the only one that
//    can catch a plan edited after its run was approved.
// 2. **Every command goes through the injected audited Bash runner.** Not
//    `execFileSync`, not a private shell: the classifier and the session mode's
//    confirmation policy apply to publication exactly as they apply to anything
//    else the seat runs, and the human sees each `host-write`, `remote-read`
//    and `remote-write` go by. Publication is not a category that gets to
//    exempt itself.
// 3. **Every failure stops BEFORE the push.** A cherry-pick conflict, a failing
//    host check, a declined confirmation — each leaves the branch in place, in
//    the working tree, where a person can look at it, and records nothing. The
//    documented fallback is the manual `git cherry-pick` that is already there.
//
// The receipt reader is deliberately tolerant. `provider.inspect` returns
// `unknown` across the seam (`workflow-provider.ts`), pi-workflow's
// `plan-to-ship` is being refactored, and the same descriptor is reachable
// under `deliverables[].handoff`, flattened onto the deliverable entry, or as
// `tasks[].handoff` on the task that produced it. The reader takes any of
// those and refuses BY FIELD NAME when one is short, because "could not read
// the receipt" is not something a human can act on.
//
// What it prefers, though, is now a fact rather than a guess. A lease-free
// `inspect(runId, {include: ["run", "tasks", "output"]})` carries the run's
// COMMITTED output verbatim on `run.output` once the run is terminal, and the
// decided value of a checkpoint on `tasks[].checkpoint.decision.value`. So the
// digest is read from `run.output.receipt.planDigest`, and `shipDecision`
// PROVES `{"ship": true}` from the `ship` checkpoint's own decided value
// instead of asking a human to vouch for something they cannot see. That proof
// is what removed publication's second confirmation: the only question left is
// the one the spec names, at the push.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { publicationFile } from "./paths.js";
import {
	type Plan,
	type PlanRepo,
	type PublishMode,
	resolvePolicy,
} from "./plan.js";
import { planDigest } from "./plan-input.js";
import { type AuditedBash, ghOnPath } from "./readiness.js";
import type {
	WorkflowReadClient,
	WorkflowRunObservationView,
} from "./workflow-provider.js";

/** The bus channel a decided `ship` checkpoint is announced on. */
export const WORKFLOW_SHIPPED_CHANNEL = "maestro:workflow-shipped";

/** What that announcement carries: which run, and which plan it claims. */
export interface WorkflowShipped {
	readonly runId: string;
	readonly planDigest: string;
}

/** The schema version of one appended publication receipt. */
export const PUBLICATION_SCHEMA_VERSION = 1 as const;

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_OBJECT_RE = /^[0-9a-f]{7,64}$/;

// ── The receipt ─────────────────────────────────────────────────────────────

/** One deliverable's handoff, as publication needs it. */
export interface HandoffDeliverable {
	/**
	 * The deliverable's id when the receipt named one, and the producing task's
	 * key when it did not. Matched against the plan tolerantly (see
	 * {@link orderDeliverables}) because a stage namespace prefixes the key.
	 */
	readonly id: string;
	readonly subagentRunId: string;
	readonly subagentAttemptId: string;
	readonly baselineHead: string;
	readonly handoffCommit: string;
	readonly sha256: string;
	readonly bytes: number;
}

/** One review verdict, when the inspection carried any. */
export interface ReviewVerdict {
	readonly lens: string;
	readonly verdict: string;
	readonly blocking: boolean;
	readonly deliverable?: string;
}

/** What a run says it produced, as far as publication reads it. */
export interface PublicationReceipt {
	readonly planDigest: string;
	readonly deliverables: readonly HandoffDeliverable[];
	/** Carried into the pull-request body when the inspection had them. */
	readonly reviews?: readonly ReviewVerdict[];
	/**
	 * Where the run worked, when the inspection says. A handoff ref is local to
	 * the repository whose object store the worktree was made in, so this is
	 * only interesting when it differs from the publication repository.
	 */
	readonly runCwd?: string;
}

/** A receipt, or the one named thing that was missing from it. */
export type ReceiptRead =
	| { readonly ok: true; readonly receipt: PublicationReceipt }
	| { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const found = value[key];
	return typeof found === "string" && found.length > 0 ? found : undefined;
}

function at(value: unknown, ...path: readonly string[]): unknown {
	let current: unknown = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

/**
 * Where a plan digest may sit, most specific first.
 *
 * `run.output.receipt.planDigest` is the real one: `run.output` is the run's
 * committed output, read back and digest-verified by the runtime, and
 * `plan-to-ship` puts its receipt there. The rest are legacy placements this
 * seat has accepted — the output inlined on the inspection, a receipt hoisted
 * to the top level — and none of them cost anything to look at.
 */
function findPlanDigest(inspection: unknown): string | undefined {
	const candidates: unknown[] = [
		at(inspection, "run", "output", "receipt"),
		at(inspection, "receipt"),
		at(inspection, "output", "receipt"),
		at(inspection, "run", "receipt"),
		at(inspection, "run", "output"),
		at(inspection, "output"),
		inspection,
	];
	for (const candidate of candidates) {
		const digest = stringAt(candidate, "planDigest");
		if (digest && SHA256_RE.test(digest)) return digest;
	}
	return undefined;
}

/**
 * The descriptor on a receipt entry, wherever this revision of `plan-to-ship`
 * put it: nested under `handoff`, or flattened onto the entry itself.
 */
function descriptorOf(entry: unknown): unknown {
	const nested = at(entry, "handoff");
	if (isRecord(nested)) return nested;
	if (isRecord(entry) && "subagentRunId" in entry) return entry;
	return undefined;
}

/** Every field publication needs, and what each is called when it is missing. */
const DESCRIPTOR_FIELDS = [
	"subagentRunId",
	"subagentAttemptId",
	"baselineHead",
	"handoffCommit",
	"sha256",
	"bytes",
] as const;

function readDescriptor(
	id: string,
	descriptor: unknown,
): HandoffDeliverable | string {
	for (const field of DESCRIPTOR_FIELDS) {
		const value = isRecord(descriptor) ? descriptor[field] : undefined;
		const present =
			field === "bytes"
				? typeof value === "number" && Number.isFinite(value) && value > 0
				: typeof value === "string" && value.length > 0;
		if (!present)
			return `publication: deliverable \`${id}\` carries no \`${field}\` in its handoff descriptor — the receipt is not one this seat can publish`;
	}
	const record = descriptor as Record<string, unknown>;
	const handoffCommit = record.handoffCommit as string;
	if (!GIT_OBJECT_RE.test(handoffCommit))
		return `publication: deliverable \`${id}\`'s \`handoffCommit\` is not a Git object id (${JSON.stringify(handoffCommit)})`;
	const sha256 = record.sha256 as string;
	if (!SHA256_RE.test(sha256))
		return `publication: deliverable \`${id}\`'s \`sha256\` is not a sha256 digest (${JSON.stringify(sha256)})`;
	return {
		id,
		subagentRunId: record.subagentRunId as string,
		subagentAttemptId: record.subagentAttemptId as string,
		baselineHead: record.baselineHead as string,
		handoffCommit,
		sha256,
		bytes: record.bytes as number,
	};
}

/** The first list of receipt entries this inspection offers, if any. */
function findDeliverableEntries(inspection: unknown): readonly unknown[] {
	const candidates: unknown[] = [
		at(inspection, "run", "output", "deliverables"),
		at(inspection, "output", "deliverables"),
		at(inspection, "receipt", "deliverables"),
		at(inspection, "deliverables"),
	];
	for (const candidate of candidates)
		if (Array.isArray(candidate) && candidate.length > 0) return candidate;
	return [];
}

/** The tasks that imported a handoff, in the order the inspection listed them. */
function findHandoffTasks(inspection: unknown): readonly unknown[] {
	const tasks = at(inspection, "tasks");
	if (!Array.isArray(tasks)) return [];
	return tasks.filter((task) => isRecord(at(task, "handoff")));
}

/** A task's own name, which is the best id a task-shaped receipt has. */
function taskId(task: unknown, ordinal: number): string {
	const key = stringAt(task, "key");
	if (!key) return `task-${ordinal}`;
	const namespace = at(task, "namespace");
	const parts = Array.isArray(namespace)
		? namespace.filter((part): part is string => typeof part === "string")
		: [];
	return [...parts, key].join("/");
}

function findReviews(
	inspection: unknown,
): readonly ReviewVerdict[] | undefined {
	const candidates: unknown[] = [
		at(inspection, "run", "output", "reviews"),
		at(inspection, "output", "reviews"),
		at(inspection, "reviews"),
	];
	for (const candidate of candidates) {
		if (!Array.isArray(candidate) || candidate.length === 0) continue;
		const verdicts: ReviewVerdict[] = [];
		for (const entry of candidate) {
			const lens = stringAt(entry, "lens");
			const verdict = stringAt(entry, "verdict");
			if (!lens || !verdict) continue;
			const deliverable = stringAt(entry, "deliverable");
			verdicts.push({
				lens,
				verdict,
				blocking: at(entry, "blocking") === true,
				...(deliverable ? { deliverable } : {}),
			});
		}
		if (verdicts.length > 0) return verdicts;
	}
	return undefined;
}

/**
 * The receipt inside a run inspection, or the reason there is not one.
 *
 * Tolerant by design, refusing by name. The two handoff placements it accepts
 * are the receipt's own `deliverables[]` — with the descriptor nested under
 * `handoff` or flattened onto the entry — and the inspection's `tasks[]`, where
 * the runtime puts the imported handoff of whichever task produced it. The
 * second is what a lease-free `inspect(runId, INSPECT_SECTIONS)` carries for a
 * run that is still being read task by task; the first is what the run's own
 * committed `run.output` says once it is terminal.
 */
export function readReceipt(inspection: unknown): ReceiptRead {
	if (!isRecord(inspection))
		return {
			ok: false,
			reason:
				"publication: the workflow run inspection is not an object — there is no receipt in it",
		};
	const digest = findPlanDigest(inspection);
	if (!digest)
		return {
			ok: false,
			reason:
				"publication: the run inspection carries no `receipt.planDigest`, so the receipt cannot be checked against the stored plan — nothing is published on an unchecked receipt",
		};

	const deliverables: HandoffDeliverable[] = [];
	const entries = findDeliverableEntries(inspection);
	if (entries.length > 0) {
		for (const [index, entry] of entries.entries()) {
			const id = stringAt(entry, "id") ?? `deliverable-${index}`;
			const read = readDescriptor(id, descriptorOf(entry));
			if (typeof read === "string") return { ok: false, reason: read };
			deliverables.push(read);
		}
	} else {
		for (const [index, task] of findHandoffTasks(inspection).entries()) {
			const read = readDescriptor(taskId(task, index), at(task, "handoff"));
			if (typeof read === "string") return { ok: false, reason: read };
			deliverables.push(read);
		}
	}
	if (deliverables.length === 0)
		return {
			ok: false,
			reason:
				"publication: the run inspection names no handoff — there is nothing to cherry-pick",
		};

	const reviews = findReviews(inspection);
	const runCwd =
		stringAt(at(inspection, "run"), "cwd") ?? stringAt(inspection, "cwd");
	return {
		ok: true,
		receipt: {
			planDigest: digest,
			deliverables,
			...(reviews ? { reviews } : {}),
			...(runCwd ? { runCwd } : {}),
		},
	};
}

// ── The ship decision ───────────────────────────────────────────────────────

/** The task key of the checkpoint a `plan-to-ship` run decides a ship at. */
export const SHIP_CHECKPOINT_KEY = "ship";

/**
 * The sections publication asks an inspection for.
 *
 * `output` is what makes the receipt a committed fact rather than a guess, and
 * `tasks` is what carries the `ship` checkpoint's decided value. Both are
 * lease-free, so asking for them never contends with a running drive.
 */
export const INSPECT_SECTIONS = {
	include: ["run", "tasks", "output"],
} as const;

/** A proven ship decision, or why this run's ship gate does not prove one. */
export type ShipDecisionRead =
	| {
			readonly ok: true;
			/** Who decided it, when the durable record names them. */
			readonly decidedBy?: string;
			/** The runtime's own name for where the decision came from. */
			readonly source?: string;
			/** The canonical digest of the decided value. */
			readonly sha256?: string;
	  }
	| { readonly ok: false; readonly reason: string };

/** The run this inspection is about, for a message a human can act on. */
function runLabel(inspection: unknown): string {
	return stringAt(at(inspection, "run"), "runId") ?? "this run";
}

/** The inspection's `ship` checkpoint task, if it declared one. */
function shipCheckpointTask(inspection: unknown): unknown {
	const tasks = at(inspection, "tasks") ?? at(inspection, "run", "tasks");
	if (!Array.isArray(tasks)) return undefined;
	return tasks.find(
		(task) =>
			at(task, "kind") === "checkpoint" &&
			stringAt(task, "key") === SHIP_CHECKPOINT_KEY,
	);
}

/** A decided value, short enough to put in a refusal. */
function render(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/**
 * Was this run DECIDED to ship? Proven, not assumed.
 *
 * The lease-free inspection carries the `ship` checkpoint's own decided value
 * on `tasks[].checkpoint.decision.value`, and shows it only when the durable
 * decision record's digest equals the journalled one — so `{"ship": true}` read
 * from here is the human's answer, not a report of it. Publication's automatic
 * trigger paths ask this instead of asking a person to vouch for a decision
 * they cannot see; `/plan ship <slug>` does not, because typing it IS the
 * decision.
 *
 * Every refusal names the run, because the thing a human does about an
 * undecided gate is go and look at that run.
 */
export function shipDecision(inspection: unknown): ShipDecisionRead {
	const run = runLabel(inspection);
	const task = shipCheckpointTask(inspection);
	if (!task)
		return {
			ok: false,
			reason: `publication: run \`${run}\` declares no \`${SHIP_CHECKPOINT_KEY}\` checkpoint, so nothing in it decided to publish anything — run \`/plan ship\` if that is what you mean`,
		};
	const decision = at(task, "checkpoint", "decision");
	if (!isRecord(decision))
		return {
			ok: false,
			reason: `publication: run \`${run}\`'s \`${SHIP_CHECKPOINT_KEY}\` checkpoint is undecided, and an undecided gate is not a decision to publish — decide it with \`/workflow decide\`, or publish by hand with \`/plan ship\``,
		};
	if (!("value" in decision))
		return {
			ok: false,
			reason: `publication: run \`${run}\`'s \`${SHIP_CHECKPOINT_KEY}\` decision carries no verified value — the lease-free inspection shows one only when the decision record matches the journalled \`sha256\`, so nothing here proves \`{"ship": true}\``,
		};
	if (at(decision.value, SHIP_CHECKPOINT_KEY) !== true)
		return {
			ok: false,
			reason: `publication: run \`${run}\`'s \`${SHIP_CHECKPOINT_KEY}\` checkpoint was decided \`${render(decision.value)}\`, which is not \`{"ship": true}\` — nothing is published`,
		};
	const decidedBy = stringAt(decision, "decidedBy");
	const source = stringAt(decision, "source");
	const sha256 = stringAt(decision, "sha256");
	return {
		ok: true,
		...(decidedBy ? { decidedBy } : {}),
		...(source ? { source } : {}),
		...(sha256 ? { sha256 } : {}),
	};
}

/** `refs/pi-subagent/handoffs/<subagentRunId>/<subagentAttemptId>`. */
export function handoffRef(deliverable: HandoffDeliverable): string {
	return `refs/pi-subagent/handoffs/${deliverable.subagentRunId}/${deliverable.subagentAttemptId}`;
}

/**
 * Does this receipt entry belong to that plan deliverable?
 *
 * Exact when the receipt named the deliverable. When it did not — a task-shaped
 * receipt names `<stage>-<deliverable>`, and a fixed deliverable's final
 * handoff comes from `<stage>-<deliverable>-fix-<n>` — the deliverable id is a
 * whole dash-separated segment of the key, which is the strongest claim that
 * can be made about a name pi-maestro did not construct.
 */
function isDeliverable(id: string, planId: string): boolean {
	if (id === planId) return true;
	const segments = id.split(/[/-]/);
	// Rejoined, because a plan id may itself contain dashes.
	for (let start = 0; start < segments.length; start++)
		for (let end = start + 1; end <= segments.length; end++)
			if (segments.slice(start, end).join("-") === planId) return true;
	return false;
}

/**
 * The receipt's deliverables in PLAN order, which is cherry-pick order.
 *
 * The receipt's own order is the runtime's declaration order, and the plan's is
 * what the author wrote and what `after` was validated against. Anything the
 * plan does not claim keeps its relative order, after everything it does.
 */
export function orderDeliverables(
	plan: Plan,
	deliverables: readonly HandoffDeliverable[],
): readonly HandoffDeliverable[] {
	const rank = (deliverable: HandoffDeliverable, ordinal: number): number => {
		const index = plan.deliverables.findIndex((planned) =>
			isDeliverable(deliverable.id, planned.id),
		);
		return index >= 0 ? index : plan.deliverables.length + ordinal;
	};
	return [...deliverables]
		.map((deliverable, ordinal) => ({
			deliverable,
			ordinal,
			rank: rank(deliverable, ordinal),
		}))
		.sort((a, b) => a.rank - b.rank || a.ordinal - b.ordinal)
		.map((entry) => entry.deliverable);
}

// ── The world publication touches ───────────────────────────────────────────

/** Just enough of `ExtensionUIContext` to ask and to report. */
export interface PublishUI {
	confirm(title: string, message: string): Promise<boolean>;
	select?(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/**
 * The same UI, deferring behind the seat's dialog gate.
 *
 * Pi's dialogs have no queue: opening one over another replaces it, and the
 * replaced promise never resolves. The exit flow has always gone through the
 * gate; publication did not, which made the seat two dialog owners of one
 * screen with only one of them listening to `ui_prompt_start`. A publication
 * confirm can land at any moment — the announcement path opens one without
 * anybody having typed a command — so it is exactly the one that needed this.
 *
 * `notify` is left alone: it is a message, not a dialog, and deferring a
 * refusal until the screen is free would delay the only thing that explains
 * why nothing happened.
 *
 * The gate is taken structurally rather than as `DialogGate` so that this
 * module keeps its one-way dependency on nothing but the plan.
 */
export function gatedPublishUI(
	ui: PublishUI,
	gate: { quiet(signal?: AbortSignal): Promise<void> },
): PublishUI {
	return {
		notify: (message, type) => ui.notify(message, type),
		confirm: async (title, message) => {
			await gate.quiet();
			return ui.confirm(title, message);
		},
		...(ui.select
			? {
					select: async (title: string, options: string[]) => {
						await gate.quiet();
						return ui.select?.(title, options);
					},
				}
			: {}),
	};
}

/** The files publication reads and appends to; injected so tests own them. */
export interface PublishFiles {
	readonly exists: (path: string) => boolean;
	/** The file's text, or `undefined` when there is no such file. */
	readonly readText: (path: string) => string | undefined;
	readonly writeText: (path: string, text: string) => void;
}

let writeCounter = 0;

export const nodeFiles: PublishFiles = {
	exists: (path) => existsSync(path),
	readText: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	writeText: (path, text) => {
		mkdirSync(dirname(path), { recursive: true });
		// tmp + rename, as the plan store writes: a reader sees the old array or
		// the new one, never a half-written receipt file.
		const tmp = `${path}.${process.pid}.${writeCounter++}.tmp`;
		writeFileSync(tmp, text, "utf8");
		renameSync(tmp, path);
	},
};

/** Shell-safe single argument. Slugs, refs and titles come from a document. */
function quote(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `yyyymmdd-hhmm` in local time: what the branch name is stamped with. */
export function branchStamp(when: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
		`-${pad(when.getHours())}${pad(when.getMinutes())}`
	);
}

/** `pi-maestro/<slug>/<yyyymmdd-hhmm>`. */
export function publicationBranch(slug: string, when: Date): string {
	return `pi-maestro/${slug}/${branchStamp(when)}`;
}

/** What check will be run on the host, and where the name came from. */
export interface HostCheck {
	readonly command: string;
	readonly source: "AGENTS.md" | "package.json";
}

const RUNNERS = /^(npm|pnpm|yarn|bun|make|just|cargo|go|deno|task) /;

/**
 * The repository's own check, named by the repository.
 *
 * `AGENTS.md` first: a repository that tells agents which command is its gate
 * has already answered this question, and answering it a second time from the
 * manifest would be this package guessing over a stated fact. The manifest is
 * the fallback, and a repository that names neither gets no check — which stops
 * publication rather than pushing something nothing verified.
 */
export function resolveHostCheck(
	repoPath: string,
	files: PublishFiles = nodeFiles,
): HostCheck | undefined {
	const manifest = files.readText(join(repoPath, "package.json"));
	const scripts = (() => {
		if (!manifest) return undefined;
		try {
			const parsed = JSON.parse(manifest) as { scripts?: unknown };
			return isRecord(parsed.scripts) ? parsed.scripts : undefined;
		} catch {
			return undefined;
		}
	})();
	// `npm ci` before an npm-run check, because the cherry-picked commits may
	// have moved the lockfile and a check run against stale node_modules is a
	// check of the wrong tree.
	const install = manifest ? "npm ci && " : "";

	const agents = files.readText(join(repoPath, "AGENTS.md"));
	if (agents) {
		for (const line of agents.split("\n")) {
			if (!/\bgate\b/i.test(line)) continue;
			for (const match of line.matchAll(/`([^`]+)`/g)) {
				const command = match[1].trim();
				if (RUNNERS.test(command))
					return {
						command: command.startsWith("npm ")
							? `${install}${command}`
							: command,
						source: "AGENTS.md",
					};
			}
		}
	}
	if (scripts && typeof scripts.check === "string")
		return { command: `${install}npm run check`, source: "package.json" };
	if (scripts && typeof scripts.test === "string")
		return { command: `${install}npm test`, source: "package.json" };
	return undefined;
}

// ── Publication ─────────────────────────────────────────────────────────────

/** The ten steps, named so a stop is a fact a test can assert. */
export const PUBLISH_STEPS = [
	"policy",
	"inspect",
	"receipt",
	"decision",
	"digest",
	"resolve",
	"branch",
	"cherry-pick",
	"check",
	"confirm",
	"push",
	"pull-request",
	"record",
] as const;

export type PublishStep = (typeof PUBLISH_STEPS)[number];

/** What a publication did, including exactly where it stopped. */
export interface Publication {
	readonly ok: boolean;
	/** The step that ended it; absent only on the happy path. */
	readonly stoppedAt?: PublishStep;
	readonly reason?: string;
	/** Every command issued, in order, whether it succeeded or not. */
	readonly commands: readonly string[];
	/** Created once step 4 ran, and left in place by every later stop. */
	readonly branch?: string;
	/** The mode actually used, which is `branch` when `gh` was missing. */
	readonly mode: PublishMode;
	readonly prUrl?: string;
	/** Where the appended receipt went. */
	readonly recorded?: string;
}

/** One appended entry in `publication.json`. */
export interface PublicationRecord {
	readonly schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
	readonly publishedAt: string;
	readonly slug: string;
	readonly runId: string;
	readonly planDigest: string;
	readonly mode: PublishMode;
	readonly base: string;
	readonly branch: string;
	readonly check: { readonly command: string; readonly passed: boolean };
	readonly deliverables: readonly {
		readonly id: string;
		readonly ref: string;
		readonly handoffCommit: string;
		readonly sha256: string;
		readonly bytes: number;
	}[];
	readonly prUrl?: string;
}

export interface PublishDeps {
	readonly slug: string;
	readonly plan: Plan;
	readonly runId: string;
	readonly provider: Pick<WorkflowReadClient, "inspect">;
	/** The seat's audited Bash tool. Every command below goes through it. */
	readonly bash: AuditedBash;
	readonly ui: PublishUI;
	readonly agentDir?: string;
	readonly files?: PublishFiles;
	readonly now?: () => Date;
	/** `gh --version`; `pr` degrades to `branch` when it says no. */
	readonly ghPresent?: () => boolean;
	/**
	 * Must the run's own `ship` gate prove this publication?
	 *
	 * Set by the automatic trigger paths, where nothing a human typed asked for
	 * this: the announcement is a message on a bus, and the only durable
	 * decision behind it is the `ship` checkpoint. `/plan ship <slug>` leaves it
	 * off, because typing the command is itself the decision, and a plan whose
	 * `gates` never declared a `ship` checkpoint is still publishable by hand.
	 */
	readonly requireShipDecision?: boolean;
}

function stop(
	ui: PublishUI,
	commands: readonly string[],
	step: PublishStep,
	reason: string,
	extra: Partial<Publication> = {},
): Publication {
	ui.notify(reason, "error");
	return {
		ok: false,
		stoppedAt: step,
		reason,
		commands,
		mode: "none",
		...extra,
	};
}

/**
 * Which repository this publication branches in.
 *
 * One branch, so one repository. A plan whose deliverables span two of them is
 * refused by name rather than published into whichever came first — the second
 * repository's handoffs would silently never reach a branch.
 */
function publicationRepo(plan: Plan): PlanRepo | string {
	const keys = new Set<string>();
	for (const deliverable of plan.deliverables)
		keys.add(deliverable.repo ?? plan.repos[0]?.key ?? "");
	if (keys.size > 1)
		return `publication: plan \`${plan.slug}\` spans repositories ${[...keys].map((key) => `\`${key}\``).join(", ")}, and a publication makes one branch in one repository — publish them separately by hand`;
	const [key] = keys;
	const repo = plan.repos.find((candidate) => candidate.key === key);
	if (!repo)
		return `publication: plan \`${plan.slug}\` names repo \`${key}\`, which is not in its \`repos\` list`;
	return repo;
}

/** The pull-request body: everything a reviewer needs to check the receipt. */
export function pullRequestBody(
	plan: Plan,
	receipt: PublicationReceipt,
	deliverables: readonly HandoffDeliverable[],
	check: HostCheck,
	branch: string,
	base: string,
): string {
	const lines = [
		`Publication of the stored plan \`${plan.slug}\` — ${plan.title}.`,
		"",
		`Plan digest: \`${receipt.planDigest}\``,
		`Branch: \`${branch}\` from \`${base}\``,
		"",
		"Handoffs, cherry-picked in plan order:",
		"",
	];
	for (const deliverable of deliverables)
		lines.push(
			`- \`${deliverable.id}\` — \`${handoffRef(deliverable)}\`` +
				` at \`${deliverable.handoffCommit}\`, sha256 \`${deliverable.sha256}\`, ${deliverable.bytes} bytes`,
		);
	lines.push(
		"",
		`Check: \`${check.command}\` ran on the host and passed. The in-worktree check a run reports is evidence, not a gate; this one is the gate.`,
	);
	if (receipt.reviews && receipt.reviews.length > 0) {
		lines.push("", "Review verdicts:", "");
		for (const review of receipt.reviews)
			lines.push(
				`- ${review.deliverable ? `\`${review.deliverable}\` ` : ""}${review.lens}: ${review.verdict}${review.blocking ? " (blocking finding)" : ""}`,
			);
	}
	lines.push(
		"",
		"The workflow runtime pushed nothing: it recorded handoff commits, and pi-maestro published them under the seat's audited Bash policy.",
	);
	return lines.join("\n");
}

/** The last URL a `gh pr create` printed, which is the pull request's. */
function pullRequestUrl(output: string): string | undefined {
	const matches = output.match(/https?:\/\/\S+/g);
	return matches ? matches[matches.length - 1] : undefined;
}

/** The tail of a failing command's output, which is the part worth showing. */
function tail(output: string, lines = 20): string {
	const all = output.trimEnd().split("\n");
	return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * Flow C, in order, stopping at the first thing that is not true.
 *
 * Every `bash` call below is the seat's audited runner: the classifier sees
 * `git switch` as `host-write`, `git fetch <path>` as `remote-read`, the check
 * as `code-execution` and `git push` / `gh pr create` as `remote-write`, and
 * the session mode's policy decides which of those it asks about. A refusal
 * there arrives here as a failed command and stops the flow exactly like a
 * failing one.
 */
export async function publishPlan(deps: PublishDeps): Promise<Publication> {
	const files = deps.files ?? nodeFiles;
	const now = deps.now ?? (() => new Date());
	const ghPresent = deps.ghPresent ?? ghOnPath;
	const ui = deps.ui;
	const commands: string[] = [];

	const run = async (command: string, intent: string) => {
		commands.push(command);
		return deps.bash(command, intent);
	};

	// ── 0. The policy, which is the authority to publish at all ──────────────
	const policy = resolvePolicy(deps.plan.policy).publish;
	if (policy.mode === "none")
		return stop(
			ui,
			commands,
			"policy",
			`publication: plan \`${deps.slug}\` sets \`policy.publish.mode: "none"\`, so nothing is branched, pushed or opened — change the plan's policy and run it again if that is not what you meant`,
		);
	if (!policy.base)
		return stop(
			ui,
			commands,
			"policy",
			`publication: plan \`${deps.slug}\` sets \`policy.publish.mode: "${policy.mode}"\` but names no base branch, and a branch has to come from somewhere`,
			{ mode: policy.mode },
		);
	const base = policy.base;
	const repo = publicationRepo(deps.plan);
	if (typeof repo === "string")
		return stop(ui, commands, "policy", repo, { mode: policy.mode });

	// `gh` is a host fact, checked before anything is created, so the
	// confirmation below describes what will actually happen.
	let mode: PublishMode = policy.mode;
	if (mode === "pr" && !ghPresent()) {
		mode = "branch";
		ui.notify(
			"publication: `gh` is not on PATH, so this publishes a branch and no pull request — install the GitHub CLI and open one by hand, or re-run `/plan ship` once it is there.",
			"warning",
		);
	}

	// ── 1. The inspection ────────────────────────────────────────────────────
	let inspection: unknown;
	try {
		inspection = await deps.provider.inspect(deps.runId, INSPECT_SECTIONS);
	} catch (error) {
		return stop(
			ui,
			commands,
			"inspect",
			`publication: run \`${deps.runId}\` could not be inspected — ${error instanceof Error ? error.message : String(error)}`,
			{ mode },
		);
	}
	const read = readReceipt(inspection);
	if (!read.ok) return stop(ui, commands, "receipt", read.reason, { mode });
	const receipt = read.receipt;

	// ── 1a. The ship gate, when nobody typed the command ─────────────────────
	if (deps.requireShipDecision) {
		const decided = shipDecision(inspection);
		if (!decided.ok)
			return stop(ui, commands, "decision", decided.reason, { mode });
	}

	// ── 2. The digest, before a single command runs ──────────────────────────
	const stored = planDigest(deps.plan);
	if (receipt.planDigest !== stored)
		return stop(
			ui,
			commands,
			"digest",
			`publication: run \`${deps.runId}\` carries plan digest \`${receipt.planDigest}\`, and the stored plan \`${deps.slug}\` is \`${stored}\` — the receipt names bytes nobody approved now, so nothing is published`,
			{ mode },
		);

	const deliverables = orderDeliverables(deps.plan, receipt.deliverables);

	// ── 3. Resolve every handoff ref ─────────────────────────────────────────
	const foreignCwd =
		receipt.runCwd && receipt.runCwd !== repo.path ? receipt.runCwd : undefined;
	for (const deliverable of deliverables) {
		const ref = handoffRef(deliverable);
		if (foreignCwd) {
			const fetched = await run(
				`git -C ${quote(repo.path)} fetch ${quote(foreignCwd)} ${quote(`${ref}:${ref}`)}`,
				`fetch the handoff of deliverable \`${deliverable.id}\` from the repository the run worked in`,
			);
			if (!fetched.ok)
				return stop(
					ui,
					commands,
					"resolve",
					`publication: \`${ref}\` could not be fetched from \`${foreignCwd}\` for deliverable \`${deliverable.id}\` — ${tail(fetched.output)}`,
					{ mode },
				);
		}
		const resolved = await run(
			`git -C ${quote(repo.path)} rev-parse --verify ${quote(`${ref}^{commit}`)}`,
			`resolve the handoff ref of deliverable \`${deliverable.id}\``,
		);
		if (!resolved.ok)
			return stop(
				ui,
				commands,
				"resolve",
				`publication: \`${ref}\` does not resolve in \`${repo.path}\` for deliverable \`${deliverable.id}\` — the handoff is not in this repository's object store`,
				{ mode },
			);
	}

	// ── 4. The branch ────────────────────────────────────────────────────────
	const branch = publicationBranch(deps.slug, now());
	const switched = await run(
		`git -C ${quote(repo.path)} switch -c ${quote(branch)} ${quote(base)}`,
		`branch \`${branch}\` from \`${base}\` to publish plan \`${deps.slug}\``,
	);
	if (!switched.ok)
		return stop(
			ui,
			commands,
			"branch",
			`publication: \`${branch}\` could not be created from \`${base}\` — ${tail(switched.output)}`,
			{ mode },
		);

	// ── 5. The cherry-picks, in plan order ───────────────────────────────────
	for (const deliverable of deliverables) {
		const picked = await run(
			`git -C ${quote(repo.path)} cherry-pick ${quote(deliverable.handoffCommit)}`,
			`cherry-pick the handoff of deliverable \`${deliverable.id}\``,
		);
		if (picked.ok) continue;
		// The abort is part of stopping, not part of recovering: it leaves the
		// branch exactly as the last clean pick left it, which is the thing a
		// person resolves the conflict on.
		await run(
			`git -C ${quote(repo.path)} cherry-pick --abort`,
			`abort the conflicted cherry-pick of deliverable \`${deliverable.id}\``,
		);
		return stop(
			ui,
			commands,
			"cherry-pick",
			`publication: deliverable \`${deliverable.id}\` (\`${deliverable.handoffCommit}\`) does not apply onto \`${branch}\` — the pick was aborted, the branch is left in place, and nothing was pushed or recorded`,
			{ mode, branch },
		);
	}

	// ── 6. The repository's own check, ON THE HOST ───────────────────────────
	const check = resolveHostCheck(repo.path, files);
	if (!check)
		return stop(
			ui,
			commands,
			"check",
			`publication: \`${repo.path}\` names no check — neither a gate in AGENTS.md nor a \`check\` or \`test\` script in package.json — and this seat does not push what nothing verified. The branch \`${branch}\` is in place`,
			{ mode, branch },
		);
	const checked = await run(
		`cd ${quote(repo.path)} && ${check.command}`,
		`run the repository's own check on the host before publishing plan \`${deps.slug}\``,
	);
	if (!checked.ok)
		return stop(
			ui,
			commands,
			"check",
			`publication: \`${check.command}\` failed on the host, so nothing is pushed. The branch \`${branch}\` is in place.\n\n${tail(checked.output)}`,
			{ mode, branch },
		);

	// ── 7. The human ─────────────────────────────────────────────────────────
	const confirmed = await ui.confirm(
		mode === "pr" ? "Push and open a pull request?" : "Push this branch?",
		[
			`Branch \`${branch}\` in \`${repo.path}\`, from \`${base}\`.`,
			`${deliverables.length} commit${deliverables.length === 1 ? "" : "s"} cherry-picked: ${deliverables.map((d) => `\`${d.id}\``).join(", ")}.`,
			`Check: \`${check.command}\` passed on the host.`,
			mode === "pr"
				? "This pushes the branch to `origin` and opens a pull request with the receipt as its body."
				: "This pushes the branch to `origin`. No pull request is opened.",
		].join("\n"),
	);
	if (!confirmed)
		return stop(
			ui,
			commands,
			"confirm",
			`publication: not pushed. The branch \`${branch}\` is in place with ${deliverables.length} commit${deliverables.length === 1 ? "" : "s"}; push it by hand, or delete it.`,
			{ mode, branch },
		);

	// ── 8. The push ──────────────────────────────────────────────────────────
	const pushed = await run(
		`git -C ${quote(repo.path)} push -u origin ${quote(branch)}`,
		`push the publication branch of plan \`${deps.slug}\``,
	);
	if (!pushed.ok)
		return stop(
			ui,
			commands,
			"push",
			`publication: \`${branch}\` could not be pushed — ${tail(pushed.output)}`,
			{ mode, branch },
		);

	// ── 9. The pull request ──────────────────────────────────────────────────
	let prUrl: string | undefined;
	if (mode === "pr") {
		const body = pullRequestBody(
			deps.plan,
			receipt,
			deliverables,
			check,
			branch,
			base,
		);
		const opened = await run(
			`cd ${quote(repo.path)} && gh pr create --base ${quote(base)} --title ${quote(deps.plan.title)} --body ${quote(body)}`,
			`open the pull request for plan \`${deps.slug}\` with its receipt as the body`,
		);
		if (!opened.ok)
			return stop(
				ui,
				commands,
				"pull-request",
				`publication: the branch \`${branch}\` is pushed, but \`gh pr create\` failed — ${tail(opened.output)}. Open the pull request by hand; nothing was recorded`,
				{ mode, branch },
			);
		prUrl = pullRequestUrl(opened.output);
	}

	// ── 10. The receipt, appended ────────────────────────────────────────────
	const record: PublicationRecord = {
		schemaVersion: PUBLICATION_SCHEMA_VERSION,
		publishedAt: now().toISOString(),
		slug: deps.slug,
		runId: deps.runId,
		planDigest: receipt.planDigest,
		mode,
		base,
		branch,
		check: { command: check.command, passed: true },
		deliverables: deliverables.map((deliverable) => ({
			id: deliverable.id,
			ref: handoffRef(deliverable),
			handoffCommit: deliverable.handoffCommit,
			sha256: deliverable.sha256,
			bytes: deliverable.bytes,
		})),
		...(prUrl ? { prUrl } : {}),
	};
	const path = publicationFile(deps.slug, deps.agentDir);
	const appended = appendPublication(path, record, files);
	if (!appended.ok)
		return stop(ui, commands, "record", appended.reason, {
			mode,
			branch,
			...(prUrl ? { prUrl } : {}),
		});

	ui.notify(
		`Published \`${deps.slug}\` as \`${branch}\`${prUrl ? ` — ${prUrl}` : ""}. Receipt appended to ${path}.`,
		"info",
	);
	return {
		ok: true,
		commands,
		branch,
		mode,
		...(prUrl ? { prUrl } : {}),
		recorded: path,
	};
}

/**
 * Append one receipt to `publication.json`, and never rewrite an earlier one.
 *
 * Append-only because a second ship of the same plan is a real event (D8): the
 * first publication's branch and pull request exist, and a file that overwrote
 * them would lose the only record that they do. Anything already in the file
 * that is not an array of receipts is a refusal rather than a fresh start —
 * publication has already happened by the time this runs, and silently
 * replacing an unreadable file is how the record of it disappears.
 */
export function appendPublication(
	path: string,
	record: PublicationRecord,
	files: PublishFiles = nodeFiles,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	const existing = files.readText(path);
	let entries: unknown[] = [];
	if (existing !== undefined && existing.trim().length > 0) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(existing);
		} catch {
			return {
				ok: false,
				reason: `publication: ${path} is not readable JSON, and this seat will not overwrite it — the publication happened; move that file aside to record it`,
			};
		}
		if (!Array.isArray(parsed))
			return {
				ok: false,
				reason: `publication: ${path} is not an array of receipts, and this seat will not overwrite it — the publication happened; move that file aside to record it`,
			};
		entries = parsed;
	}
	entries.push(record);
	files.writeText(path, `${JSON.stringify(entries, null, 2)}\n`);
	return { ok: true };
}

/** Every publication receipt stored for a slug, oldest first. */
export function readPublications(
	slug: string,
	agentDir?: string,
	files: PublishFiles = nodeFiles,
): readonly PublicationRecord[] {
	const text = files.readText(publicationFile(slug, agentDir));
	if (!text) return [];
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? (parsed as PublicationRecord[]) : [];
	} catch {
		return [];
	}
}

// ── The two trigger paths ───────────────────────────────────────────────────

/** Is this bus payload a ship announcement? */
export function isWorkflowShipped(data: unknown): data is WorkflowShipped {
	const runId = stringAt(data, "runId");
	const digest = stringAt(data, "planDigest");
	return runId !== undefined && digest !== undefined && SHA256_RE.test(digest);
}

/** Every run status that means the run will not change again. */
const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"expired",
]);

export interface ShipWatchDeps {
	readonly client: Pick<WorkflowReadClient, "inspect" | "observe">;
	readonly emit: (event: WorkflowShipped) => void;
	/**
	 * A run that carries a receipt but whose ship gate proves nothing. Said out
	 * loud rather than swallowed: the run finished, its handoffs are real, and
	 * the reason it is not being published is a fact about its `ship`
	 * checkpoint that a human can go and act on.
	 */
	readonly report?: (message: string) => void;
	/** Reported, never thrown: a watcher that throws takes the session with it. */
	readonly onError?: (error: unknown) => void;
}

/**
 * The second trigger path: a ship decided through `/workflow decide`.
 *
 * The parked-run observer prompts in the session it owns and announces its own
 * `{"ship": true}`. A decision made anywhere else never reaches that prompt, so
 * the run itself is watched: when it reaches a terminal state, it is inspected,
 * and the announcement is made once — but only for a run whose own `ship`
 * checkpoint PROVES `{"ship": true}`. A run whose gate is undecided, or decided
 * `false`, is reported by name and never announced.
 *
 * It announces; it does not publish. `publishPlan` re-reads the same inspection,
 * proves the decision again, checks the digest against the stored plan, and
 * still asks the one confirmation before anything is pushed.
 */
export function watchShippedRuns(deps: ShipWatchDeps): () => void {
	const announced = new Set<string>();
	return deps.client.observe((observation: WorkflowRunObservationView) => {
		if (!TERMINAL_STATUSES.has(observation.status)) return;
		if (announced.has(observation.runId)) return;
		announced.add(observation.runId);
		void (async () => {
			try {
				const inspection = await deps.client.inspect(
					observation.runId,
					INSPECT_SECTIONS,
				);
				const read = readReceipt(inspection);
				if (!read.ok) return;
				const decided = shipDecision(inspection);
				if (!decided.ok) {
					deps.report?.(decided.reason);
					return;
				}
				deps.emit({
					runId: observation.runId,
					planDigest: read.receipt.planDigest,
				});
			} catch (error) {
				deps.onError?.(error);
			}
		})();
	});
}

export interface ShipDeps extends Omit<PublishDeps, "runId" | "provider"> {
	readonly provider: Pick<WorkflowReadClient, "inspect" | "runs">;
	/** The run to publish, when the caller already knows it. */
	readonly runId?: string;
	/** The definition whose runs carry a plan. */
	readonly workflowRef: string;
}

/**
 * `/plan ship <slug>`: find the run this plan was shipped from, then publish it.
 *
 * More than one completed run can carry the same plan digest — a run that was
 * stopped and started again is the normal case — and picking the newest would
 * be picking for the human. The question is asked; an escape stops.
 */
export async function shipPlan(deps: ShipDeps): Promise<Publication> {
	const stored = planDigest(deps.plan);
	if (deps.runId)
		return publishPlan({ ...deps, runId: deps.runId, provider: deps.provider });

	let page: unknown;
	try {
		page = await deps.provider.runs({ statuses: ["completed"], limit: 100 });
	} catch (error) {
		return stop(
			deps.ui,
			[],
			"inspect",
			`publication: the workflow runtime could not list runs — ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const runs = at(page, "runs");
	const candidates: string[] = [];
	for (const summary of Array.isArray(runs) ? runs : []) {
		const runId = stringAt(summary, "runId");
		if (!runId) continue;
		if (stringAt(summary, "definitionName") !== deps.workflowRef) continue;
		try {
			const read = readReceipt(
				await deps.provider.inspect(runId, INSPECT_SECTIONS),
			);
			if (read.ok && read.receipt.planDigest === stored) candidates.push(runId);
		} catch {
			// One unreadable run must not hide the others; it simply is not a
			// candidate, and `/workflow` is where a broken run is looked at.
		}
	}

	if (candidates.length === 0)
		return stop(
			deps.ui,
			[],
			"inspect",
			`publication: no completed \`${deps.workflowRef}\` run carries plan \`${deps.slug}\`'s digest (\`${stored}\`) — run it first, or check \`/workflow\` for a run that parked`,
		);
	if (candidates.length === 1)
		return publishPlan({
			...deps,
			runId: candidates[0],
			provider: deps.provider,
		});

	if (!deps.ui.select)
		return stop(
			deps.ui,
			[],
			"inspect",
			`publication: ${candidates.length} completed runs carry plan \`${deps.slug}\`'s digest and this session cannot ask which — name one with \`/plan ship ${deps.slug}\` in a session with dialogs`,
		);
	const chosen = await deps.ui.select(
		`Which run of \`${deps.slug}\` is being published?`,
		[...candidates],
	);
	if (!chosen || !candidates.includes(chosen))
		return stop(
			deps.ui,
			[],
			"inspect",
			`publication: no run chosen for \`${deps.slug}\`; nothing was published`,
		);
	return publishPlan({ ...deps, runId: chosen, provider: deps.provider });
}

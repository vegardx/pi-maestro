// Persistence for the plan and its run.
//
// Two files, not one: `<root>/<slug>/plan.json` and `<root>/<slug>/run.json`.
// The types are already separate; keeping them in separate files makes the
// separation physical, so a crash while writing run state on some transition
// cannot damage the agreement the run is being measured against. The plan is
// written at authoring and on amendment; the run is written constantly.
//
// NOTHING INVALID REACHES DISK. `savePlan` refuses a plan `validatePlan`
// rejects, and `saveRun` refuses a run that does not check out against the plan
// it names. A store that will happily persist a broken plan is a store that
// turns an authoring bug into a run-time mystery days later — every serious
// defect in the old system had that shape.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Plan, validatePlan } from "./plan.js";
import { type Run, validateRun } from "./run.js";

/**
 * Bumped when a stored shape changes incompatibly. Version 1 is the first
 * Version 2 replaces persona/fan-out delegation with workflow-native review
 * intent. Nothing before it is readable, and nothing tries to be — there is no
 * migration path from the old model on purpose.
 */
export const MAESTRO_SCHEMA_VERSION = 2 as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export class StoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreError";
	}
}

/**
 * State written by a version that no longer exists. Thrown rather than
 * soft-downgraded: silently reading a shape you do not understand is how two
 * stale-state incidents got past everything.
 */
export class UnsupportedStateError extends StoreError {
	constructor(
		readonly kind: "plan" | "run",
		readonly found: unknown,
		readonly path: string,
	) {
		super(
			`${path} was written by schema ${String(found)}, and this build speaks ${MAESTRO_SCHEMA_VERSION}. ` +
				`Archive or remove the ${kind} and start again.`,
		);
		this.name = "UnsupportedStateError";
	}
}

/** A write refused because the thing being written does not check out. */
export class InvalidStateError extends StoreError {
	constructor(
		readonly kind: "plan" | "run",
		readonly errors: readonly string[],
	) {
		super(
			`refusing to save an invalid ${kind}:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
		);
		this.name = "InvalidStateError";
	}
}

export interface PlanSummary {
	readonly slug: string;
	readonly title: string;
	readonly deliverables: number;
	readonly savedAt: string;
}

export interface PlanStore {
	readonly root: string;
	exists(slug: string): boolean;
	/** Throws `UnsupportedStateError` if a file exists but speaks another schema. */
	loadPlan(slug: string): Plan | null;
	savePlan(plan: Plan): void;
	loadRun(slug: string): Run | null;
	saveRun(run: Run): void;
	/** The plan, its run, and everything else under the slug. */
	remove(slug: string): void;
	/** Most recently saved first. */
	list(): PlanSummary[];
}

export interface StoreOptions {
	/** Injected so tests do not have to reason about wall-clock time. */
	readonly now?: () => string;
}

/** Persistence metadata lives out here, so `Plan` and `Run` stay free of it. */
interface Envelope<T> {
	readonly schemaVersion: number;
	readonly savedAt: string;
	readonly body: T;
}

let writeCounter = 0;

export function createPlanStore(
	root: string,
	options: StoreOptions = {},
): PlanStore {
	const now = options.now ?? (() => new Date().toISOString());

	function dir(slug: string): string {
		if (!SLUG_RE.test(slug))
			throw new StoreError(`invalid plan slug: ${JSON.stringify(slug)}`);
		const path = join(root, slug);
		// A slug that passes the regex cannot escape, but the guard is kept
		// because the regex is the kind of thing someone relaxes later.
		const rootResolved = resolve(root);
		const rel = relative(rootResolved, resolve(path));
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new StoreError(
				`refusing to operate outside ${rootResolved}: ${path}`,
			);
		return path;
	}

	function file(slug: string, which: "plan" | "run"): string {
		return join(dir(slug), `${which}.json`);
	}

	function read<T>(path: string, kind: "plan" | "run"): T | null {
		if (!existsSync(path)) return null;
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			// Unreadable is not "absent": absent means nothing was ever written,
			// and answering `null` to a corrupt file would silently start over.
			throw new StoreError(`${path} is not readable JSON`);
		}
		const envelope = value as Partial<Envelope<T>> | null;
		if (
			typeof envelope !== "object" ||
			envelope === null ||
			envelope.schemaVersion !== MAESTRO_SCHEMA_VERSION
		)
			throw new UnsupportedStateError(
				kind,
				(envelope as { schemaVersion?: unknown } | null)?.schemaVersion ??
					"missing",
				path,
			);
		return envelope.body as T;
	}

	function write<T>(path: string, body: T): void {
		mkdirSync(join(path, ".."), { recursive: true });
		const envelope: Envelope<T> = {
			schemaVersion: MAESTRO_SCHEMA_VERSION,
			savedAt: now(),
			body,
		};
		// tmp + rename: a reader sees the old file or the new one, never half of
		// either, and never an empty file left by a crash mid-write.
		const tmp = `${path}.${process.pid}.${writeCounter++}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	}

	function savedAtOf(slug: string): string | null {
		const path = file(slug, "plan");
		if (!existsSync(path)) return null;
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as {
				savedAt?: unknown;
			};
			return typeof value.savedAt === "string" ? value.savedAt : null;
		} catch {
			return null;
		}
	}

	return {
		root,

		exists(slug) {
			return SLUG_RE.test(slug) && existsSync(file(slug, "plan"));
		},

		loadPlan(slug) {
			if (!SLUG_RE.test(slug)) return null;
			return read<Plan>(file(slug, "plan"), "plan");
		},

		savePlan(plan) {
			const errors = validatePlan(plan);
			if (errors.length > 0) throw new InvalidStateError("plan", errors);
			write(file(plan.slug, "plan"), plan);
		},

		loadRun(slug) {
			if (!SLUG_RE.test(slug)) return null;
			return read<Run>(file(slug, "run"), "run");
		},

		saveRun(run) {
			// Checked against the plan on disk, not one the caller passes in: a run
			// is only meaningful next to the agreement it ran against, and looking
			// it up here is what makes "a run naming deliverables the plan does not
			// have" unwritable rather than merely discouraged.
			const plan = this.loadPlan(run.slug);
			if (!plan)
				throw new StoreError(
					`no plan \`${run.slug}\` to record a run against — save the plan first`,
				);
			const errors = validateRun(plan, run);
			if (errors.length > 0) throw new InvalidStateError("run", errors);
			write(file(run.slug, "run"), run);
		},

		remove(slug) {
			rmSync(dir(slug), { recursive: true, force: true });
		},

		list() {
			if (!existsSync(root)) return [];
			const out: PlanSummary[] = [];
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				// A directory that is not a valid slug cannot hold a plan this
				// store wrote, so it is not one. That subsumes every convention
				// the old store needed a separate rule for.
				if (!SLUG_RE.test(entry.name)) continue;
				let plan: Plan | null;
				try {
					plan = this.loadPlan(entry.name);
				} catch {
					// One unreadable plan must not make the list unusable — that is
					// the difference between "one plan is broken" and "maestro will
					// not start". It is absent from the list, not fatal to it.
					continue;
				}
				if (!plan) continue;
				out.push({
					slug: plan.slug,
					title: plan.title,
					deliverables: plan.deliverables.length,
					savedAt: savedAtOf(entry.name) ?? "",
				});
			}
			return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
		},
	};
}

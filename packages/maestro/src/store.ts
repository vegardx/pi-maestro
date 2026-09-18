// Persistence for authored plans. Runtime state belongs to workflow journals.
//
// NOTHING INVALID REACHES DISK. `savePlan` refuses a plan `validatePlan`
// rejects. A store that will happily persist a broken plan is a store that
// turns an authoring bug into a run-time mystery days later — every serious
// defect in the old system had that shape.
//
// ONE STORE IS ONE PROJECT. The root is `plans/<project key>`, the key Pi gives
// that cwd's sessions directory, so `list` answers about the repository the
// person is standing in and a slug is unique inside it rather than across every
// repository they have ever run maestro in.

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
import {
	PLAN_FILE,
	PUBLICATION_FILE,
	projectPlansRoot,
	WORKFLOW_INPUT_FILE,
} from "./paths.js";
import {
	MAESTRO_SCHEMA_VERSION,
	type Plan,
	type PlanHostPort,
	validatePlan,
} from "./plan.js";

/**
 * The revision this build writes and reads.
 *
 * Declared with the shape it versions, in `plan.ts`, and re-exported here
 * because the envelope is where a reader of the store looks for it. One
 * definition, so the document that changed and the version that says it
 * changed cannot disagree.
 */
export { MAESTRO_SCHEMA_VERSION };

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
		readonly kind: "plan",
		readonly found: unknown,
		readonly path: string,
	) {
		super(
			`${path} was written by schema ${String(found)}, and this build speaks ${MAESTRO_SCHEMA_VERSION}. ` +
				"Schema 5 moved review routing from `tasks[].review` to `deliverables[].reviews` and dropped `stages`, and there is no migration. " +
				`Archive or remove the ${kind} and write it again at schemaVersion ${MAESTRO_SCHEMA_VERSION}.`,
		);
		this.name = "UnsupportedStateError";
	}
}

/** A write refused because the thing being written does not check out. */
export class InvalidStateError extends StoreError {
	constructor(
		readonly kind: "plan",
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
	/** `<agentDir>/maestro/plans/<project key>` — THIS project's plans. */
	readonly root: string;
	/** The project, resolved once at construction. */
	readonly cwd: string;
	exists(slug: string): boolean;
	/** Throws `UnsupportedStateError` if a file exists but speaks another schema. */
	loadPlan(slug: string): Plan | null;
	savePlan(plan: Plan): void;
	/** The plan and its directory. */
	remove(slug: string): void;
	/** Most recently saved first. This project only. */
	list(): PlanSummary[];
	/**
	 * Where a plan's files are. The ONLY answer to that question.
	 *
	 * Publication and the run export both need a path beside the plan, and both
	 * used to join one from `agentDir` themselves. With the root keyed by
	 * project that is no longer a duplicated join but a different directory, so
	 * the joins live here, next to the root they are joined to.
	 */
	planDir(slug: string): string;
	planFile(slug: string): string;
	workflowInputFile(slug: string): string;
	publicationFile(slug: string): string;
}

export interface StoreOptions {
	/**
	 * The project whose plans this store holds. Required, and resolved here.
	 *
	 * Nothing below reads `process.cwd()`: a store that found its own project
	 * would answer differently depending on where the process happened to be
	 * standing, and the seat, the tests and a future run directory all have to
	 * agree on one project per store.
	 */
	readonly cwd: string;
	/** Injected by tests, so no test writes into the real agent directory. */
	readonly agentDir?: string;
	/** Injected so tests do not have to reason about wall-clock time. */
	readonly now?: () => string;
	/**
	 * The host a pinned review model or skill is checked against, read at save
	 * time because the session it describes is not there when the store is
	 * built. @see PlanHostPort
	 *
	 * A store with none still refuses what it cannot check: this is the same
	 * `validatePlan` the plan tool ran, and a second reading that skipped the
	 * host rules would be a second opinion about what is legal — which is how a
	 * plan the tool refused reaches disk through another door.
	 */
	readonly host?: () => PlanHostPort | undefined;
}

/** Persistence metadata lives out here, so `Plan` and `Run` stay free of it. */
interface Envelope {
	readonly schemaVersion: number;
	readonly savedAt: string;
	readonly body: Plan;
}

let writeCounter = 0;

export function createPlanStore(options: StoreOptions): PlanStore {
	const now = options.now ?? (() => new Date().toISOString());
	const cwd = resolve(options.cwd);
	const root = projectPlansRoot(cwd, options.agentDir);

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

	function file(slug: string): string {
		return join(dir(slug), PLAN_FILE);
	}

	function read(path: string): Envelope | null {
		if (!existsSync(path)) return null;
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			// Unreadable is not "absent": absent means nothing was ever written,
			// and answering `null` to a corrupt file would silently start over.
			throw new StoreError(`${path} is not readable JSON`);
		}
		const envelope = value as Partial<Envelope> | null;
		if (
			typeof envelope !== "object" ||
			envelope === null ||
			envelope.schemaVersion !== MAESTRO_SCHEMA_VERSION
		)
			throw new UnsupportedStateError(
				"plan",
				(envelope as { schemaVersion?: unknown } | null)?.schemaVersion ??
					"missing",
				path,
			);
		return {
			schemaVersion: envelope.schemaVersion,
			savedAt: typeof envelope.savedAt === "string" ? envelope.savedAt : "",
			body: envelope.body as Plan,
		};
	}

	function write(path: string, body: Plan): void {
		mkdirSync(join(path, ".."), { recursive: true });
		const envelope: Envelope = {
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

	return {
		root,
		cwd,

		planDir: dir,
		planFile: file,

		workflowInputFile(slug) {
			return join(dir(slug), WORKFLOW_INPUT_FILE);
		},

		publicationFile(slug) {
			return join(dir(slug), PUBLICATION_FILE);
		},

		exists(slug) {
			return SLUG_RE.test(slug) && existsSync(file(slug));
		},

		loadPlan(slug) {
			if (!SLUG_RE.test(slug)) return null;
			return read(file(slug))?.body ?? null;
		},

		savePlan(plan) {
			const errors = validatePlan(plan, undefined, options.host?.());
			if (errors.length > 0) throw new InvalidStateError("plan", errors);
			write(file(plan.slug), plan);
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
				let envelope: Envelope | null;
				try {
					envelope = read(file(entry.name));
				} catch {
					// One unreadable plan must not make the list unusable — that is
					// the difference between "one plan is broken" and "maestro will
					// not start". It is absent from the list, not fatal to it.
					continue;
				}
				if (!envelope) continue;
				out.push({
					slug: envelope.body.slug,
					title: envelope.body.title,
					deliverables: envelope.body.deliverables.length,
					savedAt: envelope.savedAt,
				});
			}
			return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
		},
	};
}

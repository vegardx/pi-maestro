// Plan storage under the resolved agent dir: `<agentDir>/maestro/plans/`.
//
// Plans are global (not per-repo) — listable across projects — and each Plan
// carries `repoPath` to route operations back to the right working tree.
// Writes are atomic (temp file + rename). No external lock library: v1 is
// single-session; the multi-session driver-claim layer is post-v1.
//
//   <agentDir>/maestro/plans/
//   └── <slug>/plan.json

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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PLAN_SCHEMA_VERSION } from "@vegardx/pi-contracts";
import type { Plan } from "./schema.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export interface PlanSummary {
	readonly slug: string;
	readonly title: string;
	readonly repoPath: string;
	readonly updatedAt: string;
}

export interface PlanStore {
	root: string;
	exists(slug: string): boolean;
	/** Throws UnsupportedMaestroStateError for an existing unsupported payload. */
	load(slug: string): Plan | null;
	save(plan: Plan): void;
	remove(slug: string): void;
	list(): PlanSummary[];
}

export function plansRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "maestro", "plans");
}

export class UnsupportedMaestroStateError extends Error {
	constructor(
		kind: "plan" | "run" | "execution",
		found: unknown,
		expected: number,
	) {
		super(
			`Unsupported Maestro ${kind} state schema ${String(found)} (expected ${expected}). ` +
				"This release is a full cutover; archive or reset the old Maestro state and retry.",
		);
		this.name = "UnsupportedMaestroStateError";
	}
}

export function createPlanStore(root: string): PlanStore {
	function assertValidSlug(slug: string): void {
		if (!SLUG_RE.test(slug)) {
			throw new Error(`invalid plan slug: ${JSON.stringify(slug)}`);
		}
	}

	// Defence-in-depth: a resolved plan path must stay inside the root.
	function assertInsideRoot(path: string): void {
		const rootResolved = resolve(root);
		const pathResolved = resolve(path);
		if (pathResolved === rootResolved) return;
		const rel = relative(rootResolved, pathResolved);
		if (rel === "" || rel === ".") return;
		if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
			throw new Error(
				`refusing to operate outside ${rootResolved}: ${pathResolved}`,
			);
		}
	}

	function dir(slug: string): string {
		assertValidSlug(slug);
		const path = join(root, slug);
		assertInsideRoot(path);
		return path;
	}

	function file(slug: string): string {
		return join(dir(slug), "plan.json");
	}

	return {
		root,

		exists(slug) {
			return SLUG_RE.test(slug) && existsSync(file(slug));
		},

		load(slug) {
			if (!SLUG_RE.test(slug)) return null;
			const path = file(slug);
			if (!existsSync(path)) return null;
			let value: unknown;
			try {
				value = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				return null;
			}
			if (
				typeof value !== "object" ||
				value === null ||
				(value as { schemaVersion?: unknown }).schemaVersion !==
					PLAN_SCHEMA_VERSION
			) {
				throw new UnsupportedMaestroStateError(
					"plan",
					(value as { schemaVersion?: unknown } | null)?.schemaVersion ??
						"missing",
					PLAN_SCHEMA_VERSION,
				);
			}
			return value as Plan;
		},

		save(plan) {
			const d = dir(plan.slug);
			mkdirSync(d, { recursive: true });
			const path = file(plan.slug);
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
			renameSync(tmp, path);
		},

		remove(slug) {
			rmSync(dir(slug), { recursive: true, force: true });
		},

		list() {
			if (!existsSync(root)) return [];
			const out: PlanSummary[] = [];
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const plan = this.load(entry.name);
				if (!plan) continue;
				out.push({
					slug: plan.slug,
					title: plan.title,
					repoPath: plan.repoPath,
					updatedAt: plan.updatedAt,
				});
			}
			return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
	};
}

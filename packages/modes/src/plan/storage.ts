// v2 plan storage (cutover PR-4): the same atomic-write store shape as v1,
// gated on schemaVersion 6, plus the legacy-plan machinery the flip's boot
// path uses — enumerate pre-v6 plan dirs and archive them WHOLESALE (dir and
// all: events.jsonl, child-projections, crashes/, workspaces/) into
// `_legacy/`, the RunStore.archiveLegacy() pattern. One visible notice,
// never a crash: the #238/#239 stale-state incidents are the argument for
// auto-archive over a hard error. The v1 store keeps speaking version 5
// untouched until the flip.

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
import { PLAN_SCHEMA_VERSION } from "@vegardx/pi-contracts";
import { UnsupportedMaestroStateError } from "../storage.js";
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
	/** Throws UnsupportedMaestroStateError for an existing non-v6 payload. */
	load(slug: string): Plan | null;
	save(plan: Plan): void;
	remove(slug: string): void;
	list(): PlanSummary[];
}

export function createPlanStore(root: string): PlanStore {
	function assertValidSlug(slug: string): void {
		if (!SLUG_RE.test(slug))
			throw new Error(`invalid plan slug: ${JSON.stringify(slug)}`);
	}

	function assertInsideRoot(path: string): void {
		const rootResolved = resolve(root);
		const pathResolved = resolve(path);
		if (pathResolved === rootResolved) return;
		const rel = relative(rootResolved, pathResolved);
		if (rel === "" || rel === ".") return;
		if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
			throw new Error(
				`refusing to operate outside ${rootResolved}: ${pathResolved}`,
			);
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
				// `_`-prefixed dirs are harness-internal (`_legacy/`) — skipped,
				// same convention as RunStore.
				if (entry.name.startsWith("_")) continue;
				let plan: Plan | null = null;
				try {
					plan = this.load(entry.name);
				} catch {
					continue; // legacy dirs surface via legacyPlanSlugs, not list()
				}
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

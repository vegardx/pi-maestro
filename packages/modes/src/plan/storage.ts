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
import { PLAN_SCHEMA_VERSION_V2 } from "@vegardx/pi-contracts";
import { UnsupportedMaestroStateError } from "../storage.js";
import type { PlanV2 } from "./schema.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const LEGACY_DIR = "_legacy";

export interface PlanSummaryV2 {
	readonly slug: string;
	readonly title: string;
	readonly repoPath: string;
	readonly updatedAt: string;
}

export interface PlanStoreV2 {
	root: string;
	exists(slug: string): boolean;
	/** Throws UnsupportedMaestroStateError for an existing non-v6 payload. */
	load(slug: string): PlanV2 | null;
	save(plan: PlanV2): void;
	remove(slug: string): void;
	list(): PlanSummaryV2[];
}

export function createPlanStoreV2(root: string): PlanStoreV2 {
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
					PLAN_SCHEMA_VERSION_V2
			) {
				throw new UnsupportedMaestroStateError(
					"plan",
					(value as { schemaVersion?: unknown } | null)?.schemaVersion ??
						"missing",
					PLAN_SCHEMA_VERSION_V2,
				);
			}
			return value as PlanV2;
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
			const out: PlanSummaryV2[] = [];
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				// `_`-prefixed dirs are harness-internal (`_legacy/`) — skipped,
				// same convention as RunStore.
				if (entry.name.startsWith("_")) continue;
				let plan: PlanV2 | null = null;
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

/** Plan dirs whose plan.json parses but is NOT the given version. */
export function legacyPlanSlugs(
	root: string,
	currentVersion: number = PLAN_SCHEMA_VERSION_V2,
): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
		const path = join(root, entry.name, "plan.json");
		if (!existsSync(path)) continue;
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as {
				schemaVersion?: unknown;
			};
			if (value.schemaVersion !== currentVersion) out.push(entry.name);
		} catch {
			out.push(entry.name); // unreadable = legacy: archive, don't crash
		}
	}
	return out.sort();
}

export interface ArchiveLegacyResult {
	readonly archived: readonly string[];
}

/**
 * Move every legacy plan dir WHOLESALE to `<root>/_legacy/<slug>` (suffixed
 * on collision). Worktrees a legacy plan references are NOT touched —
 * recovery-style cleanup only ever acts on the live plan.
 */
export function archiveLegacyPlans(
	root: string,
	currentVersion: number = PLAN_SCHEMA_VERSION_V2,
): ArchiveLegacyResult {
	const slugs = legacyPlanSlugs(root, currentVersion);
	if (slugs.length === 0) return { archived: [] };
	const legacyRoot = join(root, LEGACY_DIR);
	mkdirSync(legacyRoot, { recursive: true });
	const archived: string[] = [];
	for (const slug of slugs) {
		let target = join(legacyRoot, slug);
		for (let n = 2; existsSync(target); n++)
			target = join(legacyRoot, `${slug}-${n}`);
		renameSync(join(root, slug), target);
		archived.push(slug);
	}
	return { archived };
}

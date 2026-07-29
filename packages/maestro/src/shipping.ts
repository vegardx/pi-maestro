// Getting a finished deliverable out: push the branch, open the pull request.
//
// Maestro does this, never the worker. An agent that ships its own work is an
// agent whose last act is unobserved, and the old system's pull requests read
// `(agent produced no summary)` because of exactly that.
//
// It also does NOT commit. A worker that called `finish` said the work was
// done, and done means committed; committing on its behalf would mean maestro
// authoring a message for a change it never saw, and shipping work under a
// description nobody wrote.

import { hasChanges, pushBranch, revParse } from "@vegardx/pi-git";
import { createPr, findOpenPr } from "@vegardx/pi-github";
import type { Shipping, ShipRequest } from "./executor.js";
import type { Deliverable } from "./plan.js";

/** The git and gh operations, so the decisions above can be tested without either. */
export interface ShippingOps {
	/** Uncommitted or untracked files in the worktree. */
	dirty(worktree: string): boolean;
	/** Whether the branch has anything the base does not. */
	hasCommits(worktree: string, branch: string, base: string): boolean;
	push(
		worktree: string,
		branch: string,
	): Promise<{ ok: boolean; error?: string }>;
	findPr(worktree: string, branch: string): Promise<number | null>;
	openPr(
		worktree: string,
		args: { title: string; body: string; base: string },
	): Promise<number | null>;
}

export interface ShippingOptions {
	readonly base: string;
	readonly ops?: Partial<ShippingOps>;
}

export function createShipping(options: ShippingOptions): Shipping {
	const ops: ShippingOps = { ...defaultOps(), ...options.ops };
	const base = options.base;

	return {
		async ship(request: ShipRequest): Promise<number | undefined> {
			if (ops.dirty(request.worktree))
				// Refused rather than committed. `finish` means the work is done,
				// and a tree with loose changes means it is not — maestro
				// inventing a commit message here would ship a change under a
				// description nobody wrote.
				throw new Error(
					"the worktree still has uncommitted changes; `finish` means the work is committed",
				);

			// A deliverable can legitimately produce no diff — research that ends
			// in a hand-off and nothing else. That is not a failure, and it does
			// not get an empty pull request.
			if (!ops.hasCommits(request.worktree, request.branch, base))
				return undefined;

			const pushed = await ops.push(request.worktree, request.branch);
			if (!pushed.ok)
				throw new Error(`could not push ${request.branch}: ${pushed.error}`);

			// Find before create: a resumed run, or a second deliverable pass,
			// must update the pull request it already has rather than fail trying
			// to open a duplicate.
			const existing = await ops.findPr(request.worktree, request.branch);
			if (existing !== null) return existing;

			const opened = await ops.openPr(request.worktree, {
				title: request.deliverable.title,
				body: prBody(request.deliverable, request.handoff),
				base,
			});
			return opened ?? undefined;
		},
	};
}

/**
 * What the pull request says.
 *
 * The hand-off leads, because it is the one thing here that the diff cannot
 * tell you. Everything after it is the plan's own words about what this
 * deliverable was for.
 */
export function prBody(deliverable: Deliverable, handoff?: string): string {
	const parts: string[] = [];
	if (handoff?.trim()) parts.push(handoff.trim());
	if (deliverable.body?.trim()) parts.push(deliverable.body.trim());
	parts.push(
		["## Work", ...deliverable.tasks.map((t) => `- ${t.title}`)].join("\n"),
	);
	return parts.join("\n\n");
}

function defaultOps(): ShippingOps {
	return {
		dirty: (worktree) => hasChanges(worktree),

		hasCommits: (worktree, branch, base) => {
			const head = revParse(worktree, branch);
			const baseSha =
				revParse(worktree, `origin/${base}`) ?? revParse(worktree, base);
			return head !== null && head !== baseSha;
		},

		push: async (worktree, branch) => {
			const result = await pushBranch(worktree, branch);
			return result.ok
				? { ok: true }
				: {
						ok: false,
						error: result.stderr.trim() || `git exit ${result.exitCode}`,
					};
		},

		findPr: async (worktree, branch) => {
			const found = await findOpenPr(worktree, branch);
			return found.pr?.number ?? null;
		},

		openPr: async (worktree, args) => {
			const created = await createPr(worktree, args);
			if (created.error)
				throw new Error(`could not open a pull request: ${created.error}`);
			return numberFromUrl(created.url);
		},
	};
}

/** `https://github.com/owner/repo/pull/42` → 42. */
export function numberFromUrl(url: string | null): number | null {
	const match = url?.match(/\/pull\/(\d+)/);
	return match ? Number.parseInt(match[1] as string, 10) : null;
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompiledPlanWorkflow } from "./workflow/plan-compiler.js";

export interface PublicationReceipt {
	readonly version: 1;
	readonly planSlug: string;
	readonly runId: string;
	readonly repositories: readonly {
		readonly key: string;
		readonly path: string;
		readonly branch: string;
		readonly baseBranch: string;
	}[];
}

export function writePublicationReceipt(
	cwd: string,
	runId: string,
	compiled: CompiledPlanWorkflow,
): PublicationReceipt {
	const receipt: PublicationReceipt = {
		version: 1,
		planSlug: compiled.planSlug,
		runId,
		repositories: compiled.repositories.map((repository) => ({
			...repository,
		})),
	};
	const path = receiptPath(cwd, compiled.planSlug);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
		mode: 0o600,
	});
	renameSync(temporary, path);
	return receipt;
}

export function readPublicationReceipt(
	cwd: string,
	planSlug: string,
): PublicationReceipt | undefined {
	try {
		const value: unknown = JSON.parse(
			readFileSync(receiptPath(cwd, planSlug), "utf8"),
		);
		if (!isReceipt(value) || value.planSlug !== planSlug)
			throw new Error("invalid publication receipt");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function receiptPath(cwd: string, planSlug: string): string {
	return join(cwd, ".pi", "maestro", "publications", `${planSlug}.json`);
}

function isReceipt(value: unknown): value is PublicationReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const receipt = value as Partial<PublicationReceipt>;
	return (
		receipt.version === 1 &&
		typeof receipt.planSlug === "string" &&
		typeof receipt.runId === "string" &&
		Array.isArray(receipt.repositories) &&
		receipt.repositories.every(
			(repository) =>
				typeof repository?.key === "string" &&
				typeof repository.path === "string" &&
				typeof repository.branch === "string" &&
				typeof repository.baseBranch === "string",
		)
	);
}

// Durable command-to-run identity. A restarted seat must re-enter the exact
// approved workflow journal instead of minting a second branch/worktree set.

import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface WorkflowCommandRun {
	readonly version: 1;
	readonly planSlug: string;
	readonly authoredDigest: string;
	readonly runId: string;
	readonly coordinatedRunRoot: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RUN_ID = /^run-[a-z0-9-]{1,123}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function workflowCommandAuthoredDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function loadOrCreateWorkflowCommandRun(input: {
	readonly maestroStateRoot: string;
	readonly coordinatedRunsRoot: string;
	readonly planSlug: string;
	readonly authoredDigest: string;
	readonly now?: () => number;
	readonly uuid?: () => string;
}): WorkflowCommandRun {
	if (!SLUG.test(input.planSlug))
		throw new Error(
			`invalid workflow plan slug: ${JSON.stringify(input.planSlug)}`,
		);
	if (!DIGEST.test(input.authoredDigest))
		throw new Error("workflow command authored digest must be SHA-256");
	const stateRoot = directory(input.maestroStateRoot, "maestro workflow state");
	const runsRoot = directory(input.coordinatedRunsRoot, "workflow runs");
	if (stateRoot === runsRoot)
		throw new Error("workflow state and coordinated runs must be disjoint");
	const registry = join(stateRoot, "command-runs");
	mkdirSync(registry, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(registry, 0o700);
	const path = join(registry, `${input.planSlug}.json`);
	const existing = read(path);
	if (existing) {
		assertRecord(existing, input.planSlug, runsRoot, input.authoredDigest);
		mkdirSync(existing.coordinatedRunRoot, { recursive: true, mode: 0o700 });
		return existing;
	}
	const now = input.now?.() ?? Date.now();
	if (!Number.isSafeInteger(now) || now < 0)
		throw new Error("workflow command clock returned an invalid value");
	const suffix = (input.uuid?.() ?? randomUUID())
		.replaceAll("-", "")
		.slice(0, 16);
	if (!/^[a-f0-9]{16}$/i.test(suffix))
		throw new Error("workflow command UUID returned an invalid value");
	const runId = `run-${now.toString(36)}-${suffix.toLowerCase()}`;
	const coordinatedRunRoot = join(runsRoot, runId);
	mkdirSync(coordinatedRunRoot, { mode: 0o700 });
	const record: WorkflowCommandRun = {
		version: 1,
		planSlug: input.planSlug,
		authoredDigest: input.authoredDigest,
		runId,
		coordinatedRunRoot: realpathSync(coordinatedRunRoot),
	};
	const temporary = `${path}.tmp-${process.pid}-${suffix}`;
	try {
		writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
	}
	return record;
}

/** Refused and fully completed commands have no in-flight work to resume. */
export function releaseWorkflowCommandRun(input: {
	readonly maestroStateRoot: string;
	readonly planSlug: string;
	readonly runId: string;
}): void {
	if (!SLUG.test(input.planSlug) || !RUN_ID.test(input.runId)) return;
	const path = join(
		resolve(input.maestroStateRoot),
		"command-runs",
		`${input.planSlug}.json`,
	);
	const record = read(path);
	if (record?.runId === input.runId) rmSync(path, { force: true });
}

/**
 * Drop a command identity only while no human approval exists. This lets a
 * user correct a plan after read-only preview or composition validation fails,
 * without turning a pre-launch error into a permanently resumable run.
 */
export function releaseUnapprovedWorkflowCommandRun(input: {
	readonly maestroStateRoot: string;
	readonly coordinatedRunsRoot: string;
	readonly planSlug: string;
	readonly runId: string;
}): boolean {
	if (!SLUG.test(input.planSlug) || !RUN_ID.test(input.runId)) return false;
	const stateRoot = directory(input.maestroStateRoot, "maestro workflow state");
	const runsRoot = directory(input.coordinatedRunsRoot, "workflow runs");
	const commandPath = join(stateRoot, "command-runs", `${input.planSlug}.json`);
	const record = read(commandPath);
	if (record?.runId !== input.runId) return false;
	if (record.coordinatedRunRoot !== join(runsRoot, input.runId))
		throw new Error("workflow command run record integrity check failed");
	const approvalPath = join(
		stateRoot,
		"workflow-approvals",
		`${input.runId}.json`,
	);
	if (existsSync(approvalPath)) return false;

	rmSync(commandPath, { force: true });
	rmSync(join(stateRoot, "workflow-plan-runs", `${input.runId}.json`), {
		force: true,
	});
	rmSync(record.coordinatedRunRoot, { recursive: true, force: true });
	return true;
}

function directory(path: string, label: string): string {
	if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`${label} must be a real directory`);
	if (process.platform !== "win32") chmodSync(path, 0o700);
	return realpathSync(path);
}

function read(path: string): WorkflowCommandRun | undefined {
	if (!existsSync(path)) return undefined;
	if (lstatSync(path).isSymbolicLink())
		throw new Error("workflow command run record cannot be a symbolic link");
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("workflow command run record is not valid JSON");
	}
	if (!value || typeof value !== "object")
		throw new Error("workflow command run record is invalid");
	return value as WorkflowCommandRun;
}

function assertRecord(
	record: WorkflowCommandRun,
	planSlug: string,
	runsRoot: string,
	authoredDigest: string,
): void {
	if (
		record.version !== 1 ||
		record.planSlug !== planSlug ||
		!DIGEST.test(record.authoredDigest) ||
		!RUN_ID.test(record.runId) ||
		record.coordinatedRunRoot !== join(runsRoot, record.runId)
	)
		throw new Error("workflow command run record integrity check failed");
	if (record.authoredDigest !== authoredDigest)
		throw new Error(
			`plan \`${planSlug}\` changed while workflow run ${record.runId} remains resumable`,
		);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("workflow command identity contains a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.filter((key) => object[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	throw new Error("workflow command identity contains a non-JSON value");
}

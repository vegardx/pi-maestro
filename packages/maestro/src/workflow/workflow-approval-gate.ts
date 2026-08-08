// One-question Plan → Auto approval gate. Compiled approval prose enters this
// module as immutable data; neither a model nor an ask loop can rewrite it.

import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { currentDepth } from "../spawn.js";

export interface WorkflowApprovalAsker {
	ask(questions: Questionnaire): Promise<Answers>;
}

export interface WorkflowApprovalRequest {
	readonly runId: string;
	readonly planSlug: string;
	/** SHA-256 of the immutable plan/execution value being approved. */
	readonly executionDigest: string;
	readonly approvalText: string;
}

export interface WorkflowApprovalRecord {
	readonly version: 1;
	readonly runId: string;
	readonly planSlug: string;
	readonly executionDigest: string;
	readonly approvalTextDigest: string;
	readonly approvedAt: string;
	readonly source: "human";
}

export type WorkflowApprovalRefusalReason =
	| "missing-answer"
	| "deferred"
	| "skipped"
	| "not-human"
	| "not-approved";

export type WorkflowApprovalControllerResult<LaunchResult> =
	| {
			readonly status: "launched";
			readonly approval: "new" | "resumed";
			readonly record: WorkflowApprovalRecord;
			readonly launchResult: LaunchResult;
	  }
	| {
			readonly status: "refused";
			readonly reason: WorkflowApprovalRefusalReason;
	  };

export interface WorkflowApprovalGateOptions {
	readonly maestroStateRoot: string;
	/** Every repository, workflow-state, and scratch root writable by descendants. */
	readonly descendantWritableRoots: readonly string[];
	readonly now?: () => Date;
	/** Test seam; production authority is always resolved from process depth. */
	readonly depth?: () => number;
}

interface ApprovalEnvelope {
	readonly digest: string;
	readonly record: WorkflowApprovalRecord;
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const APPROVAL_QUESTION_ID = "workflow-plan-approval";

export class WorkflowApprovalGate {
	readonly #root: string;
	readonly #now: () => Date;

	constructor(options: WorkflowApprovalGateOptions) {
		if ((options.depth ?? currentDepth)() !== 0)
			throw new Error("workflow approval authority belongs to depth 0");
		if (options.descendantWritableRoots.length === 0)
			throw new Error("workflow approval requires descendant-writable roots");
		const stateRoot = canonicalDirectory(options.maestroStateRoot, true);
		const root = resolve(stateRoot, "workflow-approvals");
		for (const forbidden of options.descendantWritableRoots.map(
			canonicalPath,
		)) {
			if (overlaps(root, forbidden))
				throw new Error(
					"workflow approval records must be disjoint from descendant-writable roots",
				);
		}
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(root, 0o700);
		this.#root = realpathSync(root);
		this.#now = options.now ?? (() => new Date());
	}

	async approveAndLaunch<LaunchResult>(input: {
		readonly approval: WorkflowApprovalRequest;
		readonly asker: WorkflowApprovalAsker;
		readonly launch: (
			record: WorkflowApprovalRecord,
		) => LaunchResult | Promise<LaunchResult>;
	}): Promise<WorkflowApprovalControllerResult<LaunchResult>> {
		const expected = expectedApproval(input.approval);
		const path = this.#recordPath(expected.runId);
		const existing = readApproval(path);
		if (existing) {
			assertSameApproval(existing, expected);
			return {
				status: "launched",
				approval: "resumed",
				record: existing,
				launchResult: await input.launch(existing),
			};
		}

		const answers = await input.asker.ask([
			{
				id: APPROVAL_QUESTION_ID,
				header: "Approve plan",
				question: `${input.approval.approvalText}\n\nApprove this plan and start execution?`,
				options: [
					{ label: "Yes", value: "yes" },
					{ label: "No", value: "no" },
				],
				blocking: true,
				whyBlocking: "Execution requires explicit human approval of this plan.",
			},
		]);
		const refusal = refusalReason(answers);
		if (refusal) return { status: "refused", reason: refusal };

		const approvedAt = this.#now().toISOString();
		if (Number.isNaN(Date.parse(approvedAt)))
			throw new Error("workflow approval clock returned an invalid timestamp");
		const record: WorkflowApprovalRecord = {
			version: 1,
			...expected,
			approvedAt,
			source: "human",
		};
		const persisted = persistApproval(path, record);
		assertSameApproval(persisted.record, expected);
		return {
			status: "launched",
			approval: persisted.created ? "new" : "resumed",
			record: persisted.record,
			launchResult: await input.launch(persisted.record),
		};
	}

	#recordPath(runId: string): string {
		return join(this.#root, `${runId}.json`);
	}
}

function expectedApproval(
	input: WorkflowApprovalRequest,
): Omit<WorkflowApprovalRecord, "version" | "approvedAt" | "source"> {
	assertIdentifier(input.runId, "run id");
	assertIdentifier(input.planSlug, "plan slug");
	if (!DIGEST.test(input.executionDigest))
		throw new Error("workflow approval execution digest must be SHA-256");
	if (!input.approvalText.trim())
		throw new Error("workflow approval text cannot be empty");
	if (input.approvalText.includes("\0"))
		throw new Error("workflow approval text contains a NUL byte");
	return {
		runId: input.runId,
		planSlug: input.planSlug,
		executionDigest: input.executionDigest,
		approvalTextDigest: sha256(input.approvalText),
	};
}

function refusalReason(
	answers: Answers,
): WorkflowApprovalRefusalReason | undefined {
	if (answers.length !== 1 || answers[0]?.questionId !== APPROVAL_QUESTION_ID)
		return "missing-answer";
	const answer = answers[0];
	if (answer.deferred) return "deferred";
	if (answer.skipped) return "skipped";
	if (answer.source !== "human") return "not-human";
	if (answer.value.trim().toLowerCase() !== "yes") return "not-approved";
	return undefined;
}

function persistApproval(
	path: string,
	record: WorkflowApprovalRecord,
): { readonly created: boolean; readonly record: WorkflowApprovalRecord } {
	const envelope: ApprovalEnvelope = {
		digest: sha256(canonicalJson(record)),
		record,
	};
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeSync(descriptor, canonicalJson(envelope), undefined, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		try {
			linkSync(temporary, path);
			const directory = openSync(dirname(path), "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			return { created: true, record };
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			const existing = readApproval(path);
			if (!existing)
				throw new Error("workflow approval publication raced without a record");
			return { created: false, record: existing };
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporary)) rmSync(temporary);
	}
}

function readApproval(path: string): WorkflowApprovalRecord | undefined {
	if (!existsSync(path)) return undefined;
	if (lstatSync(path).isSymbolicLink())
		throw new Error("workflow approval record cannot be a symbolic link");
	const source = readFileSync(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error("workflow approval record is not JSON");
	}
	if (
		!isRecord(value) ||
		!exactKeys(value, ["digest", "record"]) ||
		typeof value.digest !== "string" ||
		!isRecord(value.record) ||
		!validRecord(value.record) ||
		sha256(canonicalJson(value.record)) !== value.digest ||
		source !== canonicalJson(value)
	)
		throw new Error("workflow approval record integrity check failed");
	return value.record as unknown as WorkflowApprovalRecord;
}

function validRecord(value: Readonly<Record<string, unknown>>): boolean {
	return (
		exactKeys(value, [
			"version",
			"runId",
			"planSlug",
			"executionDigest",
			"approvalTextDigest",
			"approvedAt",
			"source",
		]) &&
		value.version === 1 &&
		typeof value.runId === "string" &&
		IDENTIFIER.test(value.runId) &&
		typeof value.planSlug === "string" &&
		IDENTIFIER.test(value.planSlug) &&
		typeof value.executionDigest === "string" &&
		DIGEST.test(value.executionDigest) &&
		typeof value.approvalTextDigest === "string" &&
		DIGEST.test(value.approvalTextDigest) &&
		typeof value.approvedAt === "string" &&
		!Number.isNaN(Date.parse(value.approvedAt)) &&
		value.source === "human"
	);
}

function assertSameApproval(
	record: WorkflowApprovalRecord,
	expected: Omit<WorkflowApprovalRecord, "version" | "approvedAt" | "source">,
): void {
	if (
		record.runId !== expected.runId ||
		record.planSlug !== expected.planSlug ||
		record.executionDigest !== expected.executionDigest ||
		record.approvalTextDigest !== expected.approvalTextDigest
	)
		throw new Error(
			"workflow approval identity conflicts and requires a new run id and explicit approval",
		);
}

function assertIdentifier(value: string, label: string): void {
	if (typeof value !== "string" || !IDENTIFIER.test(value))
		throw new Error(`invalid workflow approval ${label}`);
}

function canonicalDirectory(path: string, create = false): string {
	if (!isAbsolute(path))
		throw new Error(`workflow approval path must be absolute: ${path}`);
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	const canonical = realpathSync(path);
	if (!statSync(canonical).isDirectory())
		throw new Error(`workflow approval path is not a directory: ${path}`);
	return canonical;
}

function canonicalPath(input: string): string {
	if (!isAbsolute(input))
		throw new Error(`workflow approval path must be absolute: ${input}`);
	let cursor = resolve(input);
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(
			cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
		);
		cursor = parent;
	}
	const canonical = resolve(realpathSync(cursor), ...missing);
	if (canonical === parse(canonical).root)
		throw new Error("workflow approval path cannot be the filesystem root");
	return canonical;
}

function overlaps(left: string, right: string): boolean {
	const leftToRight = relative(left, right);
	const rightToLeft = relative(right, left);
	return (
		leftToRight === "" ||
		(!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
		(!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
	return (
		isRecord(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	throw new Error("workflow approval record contains a non-JSON value");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

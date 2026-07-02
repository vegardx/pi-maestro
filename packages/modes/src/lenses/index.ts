import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TokenSnapshot } from "@vegardx/pi-contracts";
import { accumulate, type UsageDelta } from "../usage-ledger.js";

export type LensName = "review" | "refine" | "validate";
export type Situation =
	| "diff"
	| "working-tree"
	| "files"
	| "project"
	| "project-unit"
	| "plan";

export interface Finding {
	severity: string;
	file?: string;
	line?: number;
	title: string;
	description?: string;
	suggestedAction?: string;
}

export type LensScope =
	| { situation: "files"; paths: string[] }
	| { situation: "plan" }
	| { situation: "working-tree"; range: string }
	| { situation: "diff"; range: string }
	| { situation: "project" };

export interface GitInfo {
	defaultBranch: string;
	currentBranch: string | null;
	dirty: boolean;
}

/**
 * Decide what a lens should analyse. Pure over the supplied git info so it is
 * testable; the runtime wrapper gathers git state first.
 *  - explicit paths     -> those files
 *  - plan mode + plan    -> the plan document
 *  - dirty working tree  -> working-tree diff ("review what I'm working on")
 *  - feature branch      -> diff vs base
 *  - default branch clean -> project (no injection; caller shows guidance)
 */
export function detectScope(
	args: string,
	mode: string,
	git: GitInfo,
	hasPlan: boolean,
): LensScope {
	const trimmed = args.trim();
	if (trimmed) return { situation: "files", paths: trimmed.split(/\s+/) };
	if (mode === "plan" && hasPlan) return { situation: "plan" };
	if (git.dirty) return { situation: "working-tree", range: "HEAD" };
	if (git.currentBranch && git.currentBranch !== git.defaultBranch)
		return { situation: "diff", range: `${git.defaultBranch}...HEAD` };
	return { situation: "project" };
}

// ─── Prompt composition (lensCore × situationFrame) ─────────────────────────

const LENS_DIR = fileURLToPath(new URL(".", import.meta.url));
const lensCoreCache = new Map<LensName, string>();

function lensCore(lens: LensName): string {
	let cached = lensCoreCache.get(lens);
	if (!cached) {
		cached = readFileSync(join(LENS_DIR, `${lens}.md`), "utf8");
		lensCoreCache.set(lens, cached);
	}
	return cached;
}

const SITUATION_FRAME: Record<Situation, string> = {
	diff: "You are reviewing a DIFF against the base branch. Review only the changes; assume the rest of the tree is stable. Weigh the blast radius of the change.",
	"working-tree":
		"You are reviewing UNCOMMITTED CHANGES. Review only these changes; assume the rest of the tree is stable.",
	files: "You are reviewing the provided files as given.",
	"project-unit":
		"You are reviewing one module in isolation. Surface cross-module concerns for the aggregator rather than resolving them.",
	project:
		"You are reviewing an entire project. Focus on the most important issues.",
	plan: "You are reviewing a PLAN (not code). Assess whether deliverables are well-scoped, tasks are concrete enough for an agent, dependencies parallelize, and requirements are covered.",
};

export function buildSystemPrompt(
	lens: LensName,
	situation: Situation,
): string {
	const frame = SITUATION_FRAME[situation] ?? SITUATION_FRAME.files;
	return `${lensCore(lens)}\n\n## Situation\n${frame}`;
}

// ─── Finding extraction (tolerant of prose) ─────────────────────────────────

/**
 * Extract findings from an assistant message. Prefers a fenced ```json block,
 * else the last top-level JSON array. Schema-validates each entry; drops
 * malformed ones. Never throws — returns [] when nothing parses.
 */
export function parseFindings(text: string): Finding[] {
	const raw = extractJsonArray(text);
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: Finding[] = [];
	for (const item of parsed) {
		if (item && typeof item === "object" && "title" in item) {
			const f = item as Record<string, unknown>;
			out.push({
				severity: typeof f.severity === "string" ? f.severity : "MINOR",
				title: String(f.title),
				file: typeof f.file === "string" ? f.file : undefined,
				line: typeof f.line === "number" ? f.line : undefined,
				description:
					typeof f.description === "string" ? f.description : undefined,
				suggestedAction:
					typeof f.suggestedAction === "string" ? f.suggestedAction : undefined,
			});
		}
	}
	return out;
}

function extractJsonArray(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
	if (fenced) return fenced[1];
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start !== -1 && end > start) return text.slice(start, end + 1);
	return null;
}

// ─── Running a lens as an ephemeral pi subprocess ───────────────────────────

export interface SpawnResult {
	stdout: string;
	exitCode: number;
}

export type SpawnFn = (
	args: string[],
	opts: { cwd: string },
) => Promise<SpawnResult>;

/**
 * Spawn `pi` with the maestro env stripped and extensions/session disabled,
 * so a child pi can never load the orchestrator extension or become a rogue
 * agent. The single choke point for child-pi hygiene.
 */
export const spawnCleanPi: SpawnFn = (args, opts) => {
	const env = { ...process.env };
	delete env.PI_MAESTRO_SOCK;
	delete env.PI_MAESTRO_AGENT_ID;
	return new Promise((resolve) => {
		const child = spawn("pi", ["-ne", "--no-session", ...args], {
			cwd: opts.cwd,
			env,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => {
			stdout += c;
		});
		child.on("error", () => resolve({ stdout: "", exitCode: -1 }));
		child.on("close", (code) => resolve({ stdout, exitCode: code ?? 0 }));
	});
};

export interface RunLensOptions {
	cwd: string;
	/** Rendered scope text (diff/files/plan). */
	input: string;
	/** For validate: the requirements to check against. */
	requirements?: string;
	model?: string;
	spawnFn?: SpawnFn;
}

export interface LensResult {
	lens: LensName;
	findings: Finding[];
	usage: TokenSnapshot;
	error?: string;
}

/** Run one lens over the given input; returns findings + real usage. */
export async function runLens(
	lens: LensName,
	situation: Situation,
	opts: RunLensOptions,
): Promise<LensResult> {
	const usageZero = accumulate(undefined, {});
	const dir = mkdtempSync(join(tmpdir(), "maestro-lens-"));
	const scopeFile = join(dir, "scope.txt");
	writeFileSync(scopeFile, opts.input);
	const instruction =
		lens === "validate"
			? `Validate the implementation against these requirements:\n${opts.requirements ?? "(none provided)"}`
			: `Run the ${lens} analysis.`;
	const args = [
		"--mode",
		"json",
		"--system-prompt",
		buildSystemPrompt(lens, situation),
		...(opts.model ? ["--model", opts.model] : []),
		`@${scopeFile}`,
		instruction,
	];
	const spawnFn = opts.spawnFn ?? spawnCleanPi;
	const result = await spawnFn(args, { cwd: opts.cwd });
	if (result.exitCode !== 0) {
		return {
			lens,
			findings: [],
			usage: usageZero,
			error: `pi exited ${result.exitCode}`,
		};
	}
	const { text, usage } = parseEventStream(result.stdout);
	return { lens, findings: parseFindings(text), usage };
}

/** Parse a `pi --mode json` JSONL event stream: last assistant text + usage. */
export function parseEventStream(stdout: string): {
	text: string;
	usage: TokenSnapshot;
} {
	let text = "";
	let usage = accumulate(undefined, {});
	let recorded = false;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const msg = extractMessage(obj);
		if (!msg || msg.role !== "assistant") continue;
		if (typeof msg.text === "string") text = msg.text;
		if (msg.usage) {
			usage = accumulate(usage, msg.usage);
			recorded = true;
		}
	}
	return { text, usage: recorded ? usage : accumulate(undefined, {}) };
}

interface FlatMessage {
	role?: string;
	text?: string;
	usage?: UsageDelta;
}

function extractMessage(obj: unknown): FlatMessage | null {
	if (!obj || typeof obj !== "object") return null;
	const record = obj as Record<string, unknown>;
	const message = (record.message ?? record) as Record<string, unknown>;
	if (typeof message.role !== "string") return null;
	return {
		role: message.role,
		text: flattenContent(message.content),
		usage: message.usage as UsageDelta | undefined,
	};
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && "text" in p
				? String((p as { text: unknown }).text)
				: "",
		)
		.join("");
}

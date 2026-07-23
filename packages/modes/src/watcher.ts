// The watcher (design §The watcher): goal-driven eyes on anything external.
// Compile once (fast-tier LLM + watch skills) → a READ-ONLY probe command and
// a TypeScript canonicalizer; the harness ticks the probe deterministically —
// no model per ping. The LLM judges only when the canonical state changes:
// goal-relevant → raise; noise → refine the canonicalizer (logged rationale,
// capped, replay-checked so old signal states still canonicalize apart);
// probe broken → raise probe-failed. Silence is never success: probe failure
// and expiry always raise, and expiry carries the refinement history so a
// wrongly-ignored signal is discoverable.
//
// Watches are process-local to their owning session and raise to their
// creator. Caller prompts ship here (invariant 6); the `tool:watch` policy
// row tunes the tier.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_WATCH_CAPS,
	type WatchCaps,
	type WatchLifetime,
	type WatchProbe,
	type WatchRaise,
	type WatchRecord,
	type WatchRefinement,
	type WatchStatus,
} from "@vegardx/pi-contracts";
import { resolveModelAuth, resolveV2Model } from "@vegardx/pi-models";
import { decideBashPolicy } from "./bash-policy.js";
import { policyRowFor, readPolicyTable } from "./policy-table.js";
import { readExecutionPolicySettings } from "./settings.js";

const JUDGE_TIMEOUT_MS = 30_000;
const COMPILE_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const CANONICALIZER_TIMEOUT_MS = 10_000;
const RAW_HISTORY_LIMIT = 10;
const MAX_MODEL_TOKENS = 1_500;

// ─── Skills ──────────────────────────────────────────────────────────────────

/** Bundled watch skills (packages/modes/watch-skills/*.md), joined. */
export function loadWatchSkills(dir?: string): string {
	const root =
		dir ?? join(new URL(".", import.meta.url).pathname, "..", "watch-skills");
	try {
		return readdirSync(root)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => readFileSync(join(root, name), "utf8"))
			.join("\n\n");
	} catch {
		return "";
	}
}

// ─── Caller prompts (harness-owned, versioned) ───────────────────────────────

export function buildCompilePrompt(goal: string, skills: string): string {
	return [
		"You are the watcher of an agent harness: goal-driven eyes on external",
		"state. Compile this monitoring goal into a deterministic probe the",
		"harness will run on a timer WITHOUT you, plus a canonicalizer that",
		"reduces probe output to a stable state string. You are woken only when",
		"the canonical string changes.",
		"",
		"Discipline: prefer real CLIs with structured output (--json flags)",
		"over scraping; write the canonicalizer as a TypeScript program; shell",
		"pipelines only as a last resort. The probe must be strictly READ-ONLY.",
		"Project to exactly the goal-relevant fields; drop timestamps,",
		"durations, counters, and URLs — they change every poll.",
		"",
		"## Domain recipes",
		skills || "(no skills bundled)",
		"",
		"## Goal",
		goal,
		"",
		"Reply with EXACTLY one JSON object, nothing else:",
		'{"command":"<read-only shell command>",',
		' "intervalMs":<number>,',
		' "canonicalizer":"<TypeScript program: reads the probe output on',
		" stdin, prints the canonical state string on stdout. Use only node",
		' built-ins.>"}',
	].join("\n");
}

export interface JudgeInput {
	readonly goal: string;
	readonly previousState: string | undefined;
	readonly currentState: string;
	readonly rawOutput: string;
	readonly probeError?: string;
	readonly refinements: readonly WatchRefinement[];
	readonly refinementsLeft: number;
}

export function buildJudgePrompt(input: JudgeInput): string {
	return [
		"You are the watcher of an agent harness. The canonical state of a",
		"watched target changed (or the probe failed). Judge it against the",
		"goal.",
		"",
		"## Goal",
		input.goal,
		"",
		`Previous canonical state: ${input.previousState ?? "(first observation)"}`,
		`Current canonical state: ${input.currentState}`,
		...(input.probeError ? [`Probe error: ${input.probeError}`] : []),
		"Raw probe output (bounded):",
		"```",
		input.rawOutput.slice(0, 4_000),
		"```",
		...(input.refinements.length > 0
			? [
					"Prior refinements (do not re-widen):",
					...input.refinements.map((r) => `- ${r.rationale}`),
				]
			: []),
		`Refinements left before the cap: ${input.refinementsLeft}`,
		"",
		"Reply with EXACTLY one JSON object, nothing else — one of:",
		'{"action":"raise","summary":"<what happened, one or two sentences>"}',
		'{"action":"continue","note":"<why this change is not the goal yet>"}',
		'{"action":"refine","rationale":"<why this change class is noise and',
		' not goal-relevant>","canonicalizer":"<replacement TypeScript program>"}',
		'{"action":"repair","canonicalizer":"<fixed program>","command":"<fixed',
		' read-only command, only if the command itself must change>"}',
		"",
		"- raise when the goal's condition is met (or, for probe failures on a",
		"  health goal, when the failure IS the signal).",
		"- refine ONLY for noise: argue why the change class cannot be the",
		"  goal. Never widen what you previously narrowed.",
		"- repair when the probe or canonicalizer is broken.",
	].join("\n");
}

// ─── Verdict parsing (tolerant, null on malformed) ───────────────────────────

export interface CompileResult {
	readonly command: string;
	readonly intervalMs: number;
	readonly canonicalizer: string;
}

export type JudgeVerdict =
	| { action: "raise"; summary: string }
	| { action: "continue"; note?: string }
	| { action: "refine"; rationale: string; canonicalizer: string }
	| { action: "repair"; canonicalizer: string; command?: string };

function extractJson(text: string): unknown | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

export function parseCompileResult(text: string): CompileResult | null {
	const value = extractJson(text) as Partial<CompileResult> | null;
	if (!value) return null;
	if (
		typeof value.command !== "string" ||
		!value.command.trim() ||
		typeof value.canonicalizer !== "string" ||
		!value.canonicalizer.trim() ||
		typeof value.intervalMs !== "number" ||
		!Number.isFinite(value.intervalMs)
	)
		return null;
	return {
		command: value.command,
		intervalMs: value.intervalMs,
		canonicalizer: value.canonicalizer,
	};
}

export function parseJudgeVerdict(text: string): JudgeVerdict | null {
	const value = extractJson(text) as Record<string, unknown> | null;
	if (!value) return null;
	switch (value.action) {
		case "raise":
			return typeof value.summary === "string" && value.summary.trim()
				? { action: "raise", summary: value.summary.trim() }
				: null;
		case "continue":
			return {
				action: "continue",
				...(typeof value.note === "string" ? { note: value.note } : {}),
			};
		case "refine":
			return typeof value.rationale === "string" &&
				value.rationale.trim() &&
				typeof value.canonicalizer === "string" &&
				value.canonicalizer.trim()
				? {
						action: "refine",
						rationale: value.rationale.trim(),
						canonicalizer: value.canonicalizer,
					}
				: null;
		case "repair":
			return typeof value.canonicalizer === "string" &&
				value.canonicalizer.trim()
				? {
						action: "repair",
						canonicalizer: value.canonicalizer,
						...(typeof value.command === "string" && value.command.trim()
							? { command: value.command }
							: {}),
					}
				: null;
		default:
			return null;
	}
}

// ─── Deterministic execution seams ───────────────────────────────────────────

export type ProbeRunner = (
	command: string,
) => Promise<{ ok: boolean; output: string; error?: string }>;

export type CanonicalizerRunner = (
	source: string,
	rawOutput: string,
) => Promise<{ ok: boolean; state: string; error?: string }>;

export const defaultProbeRunner: ProbeRunner = (command) =>
	new Promise((resolve) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error)
					resolve({
						ok: false,
						output: String(stdout ?? ""),
						error: (stderr || error.message).slice(0, 2_000),
					});
				else resolve({ ok: true, output: String(stdout ?? "") });
			},
		);
	});

/** Run the TS canonicalizer via node's native type stripping (Node ≥ 22.6). */
export const defaultCanonicalizerRunner: CanonicalizerRunner = (
	source,
	rawOutput,
) =>
	new Promise((resolve) => {
		const file = join(tmpdir(), `watch-canon-${randomUUID()}.ts`);
		try {
			writeFileSync(file, source, "utf8");
		} catch (error) {
			resolve({
				ok: false,
				state: "",
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const child = execFile(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", file],
			{ timeout: CANONICALIZER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				try {
					rmSync(file, { force: true });
				} catch {}
				if (error)
					resolve({
						ok: false,
						state: "",
						error: (stderr || error.message).slice(0, 2_000),
					});
				else resolve({ ok: true, state: String(stdout ?? "").trim() });
			},
		);
		child.stdin?.write(rawOutput);
		child.stdin?.end();
	});

// ─── The probe's read-only gate ──────────────────────────────────────────────

/**
 * A probe must pass the bash policy at the REVIEWER posture (the read-only
 * invariant): any write, delivery, privileged, or destructive classification
 * rejects it. "unknown" is rejected too — a probe the classifier cannot place
 * has no business running unattended on a timer.
 */
export function probePolicyProblem(
	command: string,
	cwd: string,
): string | null {
	const decision = decideBashPolicy({
		command,
		mode: "auto",
		actor: "reviewer",
		policy: readExecutionPolicySettings(cwd),
	});
	if (decision.route === "deny") return decision.reason;
	if (decision.effects.has("unknown"))
		return "probe classifies as unknown — watchers may only run clearly read-only commands";
	return null;
}

// ─── The manager ─────────────────────────────────────────────────────────────

interface WatchInternal {
	record: WatchRecord;
	rawHistory: string[];
	timer?: ReturnType<typeof setInterval>;
	expiryTimer?: ReturnType<typeof setTimeout>;
	judging: boolean;
}

export interface WatchManagerDeps {
	/** Deliver a raise to the owning session (followUp message). */
	readonly raise: (raise: WatchRaise) => void;
	readonly probeRunner?: ProbeRunner;
	readonly canonicalizerRunner?: CanonicalizerRunner;
	/** LLM seam: prompt in, text out. Defaults to the tool:watch row model. */
	readonly modelCall?: (
		ctx: ExtensionContext,
		prompt: string,
		timeoutMs: number,
	) => Promise<string | null>;
	readonly now?: () => string;
	/** Test seam: when set, no real interval/expiry timers are armed. */
	readonly manualTicks?: boolean;
	readonly skills?: string;
}

export class WatchManager {
	private readonly watches = new Map<string, WatchInternal>();
	private readonly probeRunner: ProbeRunner;
	private readonly canonicalizerRunner: CanonicalizerRunner;
	private readonly now: () => string;

	constructor(private readonly deps: WatchManagerDeps) {
		this.probeRunner = deps.probeRunner ?? defaultProbeRunner;
		this.canonicalizerRunner =
			deps.canonicalizerRunner ?? defaultCanonicalizerRunner;
		this.now = deps.now ?? (() => new Date().toISOString());
	}

	list(): WatchRecord[] {
		return [...this.watches.values()].map((w) => w.record);
	}

	get(id: string): WatchRecord | undefined {
		return this.watches.get(id)?.record;
	}

	async create(
		ctx: ExtensionContext,
		input: {
			goal: string;
			lifetime?: WatchLifetime;
			caps?: Partial<WatchCaps>;
		},
	): Promise<{ ok: true; record: WatchRecord } | { ok: false; error: string }> {
		const caps: WatchCaps = { ...DEFAULT_WATCH_CAPS, ...input.caps };
		const skills = this.deps.skills ?? loadWatchSkills();
		const reply = await this.modelCall(
			ctx,
			buildCompilePrompt(input.goal, skills),
			COMPILE_TIMEOUT_MS,
		);
		const compiled = reply ? parseCompileResult(reply) : null;
		if (!compiled)
			return {
				ok: false,
				error: "watch compilation failed (no usable probe from the model)",
			};
		const problem = probePolicyProblem(compiled.command, ctx.cwd);
		if (problem)
			return { ok: false, error: `probe rejected by policy: ${problem}` };

		const probe: WatchProbe = {
			command: compiled.command,
			intervalMs: Math.max(compiled.intervalMs, caps.minIntervalMs),
			canonicalizer: compiled.canonicalizer,
		};
		const ts = this.now();
		const record: WatchRecord = {
			id: `watch-${randomUUID().slice(0, 8)}`,
			goal: input.goal,
			lifetime: input.lifetime ?? "one-shot",
			caps,
			probe,
			status: "active",
			refinements: [],
			raises: 0,
			createdAt: ts,
			updatedAt: ts,
		};
		const internal: WatchInternal = {
			record,
			rawHistory: [],
			judging: false,
		};
		this.watches.set(record.id, internal);
		if (!this.deps.manualTicks) {
			internal.timer = setInterval(() => {
				void this.tick(ctx, record.id);
			}, probe.intervalMs);
			(internal.timer as { unref?: () => void }).unref?.();
			internal.expiryTimer = setTimeout(() => {
				void this.expire(record.id);
			}, caps.maxDurationMs);
			(internal.expiryTimer as { unref?: () => void }).unref?.();
			// First observation promptly, not one interval late.
			void this.tick(ctx, record.id);
		}
		return { ok: true, record };
	}

	cancel(id: string, reason = "cancelled by owner"): boolean {
		const internal = this.watches.get(id);
		// biome-ignore lint/complexity/useOptionalChain: internal is dereferenced below — the "fix" would pass undefined onward
		if (!internal || internal.record.status !== "active") return false;
		this.end(internal, "cancelled", reason);
		return true;
	}

	/** Cancel every live watch (owner session is ending). */
	destroy(): void {
		for (const internal of this.watches.values()) {
			if (internal.record.status === "active")
				this.end(internal, "cancelled", "owner session ended");
		}
	}

	/** One probe tick. Public for tests (manualTicks) and prompt observation. */
	async tick(ctx: ExtensionContext, id: string): Promise<void> {
		const internal = this.watches.get(id);
		// biome-ignore lint/complexity/useOptionalChain: internal is dereferenced below — the "fix" would pass undefined onward
		if (!internal || internal.record.status !== "active") return;
		if (internal.judging) return; // one judgment in flight per watch
		const probe = internal.record.probe;
		const result = await this.probeRunner(probe.command);
		if (internal.record.status !== "active") return;

		if (!result.ok) {
			await this.judgeAndAct(ctx, internal, {
				rawOutput: result.output,
				currentState: `(probe failed: ${result.error ?? "unknown error"})`,
				probeError: result.error ?? "unknown error",
			});
			return;
		}
		const canon = await this.canonicalizerRunner(
			probe.canonicalizer,
			result.output,
		);
		if (internal.record.status !== "active") return;
		if (!canon.ok) {
			await this.judgeAndAct(ctx, internal, {
				rawOutput: result.output,
				currentState: `(canonicalizer failed: ${canon.error ?? "unknown error"})`,
				probeError: `canonicalizer: ${canon.error ?? "unknown error"}`,
			});
			return;
		}
		this.remember(internal, result.output);
		const previous = internal.record.lastState;
		if (previous === canon.state) return; // the cheap path: no model
		if (previous === undefined) {
			// Baseline observation: record silently, never judge or raise.
			internal.record = {
				...internal.record,
				lastState: canon.state,
				updatedAt: this.now(),
			};
			return;
		}
		await this.judgeAndAct(ctx, internal, {
			rawOutput: result.output,
			currentState: canon.state,
		});
	}

	// ── internals ──

	private async judgeAndAct(
		ctx: ExtensionContext,
		internal: WatchInternal,
		observed: {
			rawOutput: string;
			currentState: string;
			probeError?: string;
		},
	): Promise<void> {
		internal.judging = true;
		try {
			const record = internal.record;
			const reply = await this.modelCall(
				ctx,
				buildJudgePrompt({
					goal: record.goal,
					previousState: record.lastState,
					currentState: observed.currentState,
					rawOutput: observed.rawOutput,
					...(observed.probeError ? { probeError: observed.probeError } : {}),
					refinements: record.refinements,
					refinementsLeft:
						record.caps.maxRefinements - record.refinements.length,
				}),
				JUDGE_TIMEOUT_MS,
			);
			const verdict = reply ? parseJudgeVerdict(reply) : null;
			if (internal.record.status !== "active") return;
			if (!verdict) {
				// Judge unavailable: a probe failure still raises (silence is
				// never success); an unjudged state change carries to the next
				// tick by NOT updating lastState.
				if (observed.probeError) {
					this.raise(internal, {
						kind: "probe-failed",
						summary: `probe failed and the watcher could not judge it: ${observed.probeError}`,
					});
					this.end(internal, "failed", "probe failed");
				}
				return;
			}
			switch (verdict.action) {
				case "raise": {
					this.raise(internal, {
						kind: observed.probeError ? "probe-failed" : "triggered",
						summary: verdict.summary,
					});
					internal.record = {
						...internal.record,
						lastState: observed.currentState,
						raises: internal.record.raises + 1,
						updatedAt: this.now(),
					};
					if (
						internal.record.lifetime === "one-shot" ||
						internal.record.raises >= internal.record.caps.maxRaises
					) {
						this.end(internal, "triggered", verdict.summary);
					}
					return;
				}
				case "continue": {
					internal.record = {
						...internal.record,
						lastState: observed.currentState,
						updatedAt: this.now(),
					};
					return;
				}
				case "refine": {
					if (
						internal.record.refinements.length >=
						internal.record.caps.maxRefinements
					) {
						this.raise(internal, {
							kind: "refinement-cap",
							summary:
								"the watcher keeps seeing changes it classifies as noise and has hit its refinement cap — the goal may need a narrower probe",
						});
						this.end(internal, "failed", "refinement cap reached");
						return;
					}
					const replay = await this.replayCheck(
						internal,
						verdict.canonicalizer,
						observed.currentState,
					);
					if (!replay.ok) {
						// A refinement that cannot prove itself is discarded; the
						// state change carries to the next tick unjudged.
						return;
					}
					const refinement: WatchRefinement = {
						at: this.now(),
						rationale: verdict.rationale,
						previousCanonicalizer: internal.record.probe.canonicalizer,
					};
					internal.record = {
						...internal.record,
						probe: {
							...internal.record.probe,
							canonicalizer: verdict.canonicalizer,
						},
						lastState: replay.newState,
						refinements: [...internal.record.refinements, refinement],
						updatedAt: this.now(),
					};
					return;
				}
				case "repair": {
					if (verdict.command) {
						const problem = probePolicyProblem(verdict.command, ctx.cwd);
						if (problem) {
							this.raise(internal, {
								kind: "probe-failed",
								summary: `the watcher's repaired probe was rejected by policy: ${problem}`,
							});
							this.end(internal, "failed", "repair rejected by policy");
							return;
						}
					}
					internal.record = {
						...internal.record,
						probe: {
							...internal.record.probe,
							...(verdict.command ? { command: verdict.command } : {}),
							canonicalizer: verdict.canonicalizer,
						},
						// Repaired artifacts re-baseline on the next tick.
						lastState: undefined,
						updatedAt: this.now(),
					};
					return;
				}
			}
		} finally {
			internal.judging = false;
		}
	}

	/**
	 * Replay-check a refinement: the new canonicalizer must run cleanly on
	 * every recorded raw output, and must collapse the CURRENT (noise) state
	 * into the previous canonical state — that collapse is the refinement's
	 * entire claim. Uncheckable → rejected.
	 */
	private async replayCheck(
		internal: WatchInternal,
		canonicalizer: string,
		_noisyState: string,
	): Promise<{ ok: boolean; newState?: string }> {
		let newState: string | undefined;
		for (const raw of internal.rawHistory) {
			const result = await this.canonicalizerRunner(canonicalizer, raw);
			if (!result.ok) return { ok: false };
			newState = result.state;
		}
		if (newState === undefined) return { ok: false };
		return { ok: true, newState };
	}

	private remember(internal: WatchInternal, raw: string): void {
		internal.rawHistory.push(raw);
		if (internal.rawHistory.length > RAW_HISTORY_LIMIT)
			internal.rawHistory.shift();
	}

	private async expire(id: string): Promise<void> {
		const internal = this.watches.get(id);
		// biome-ignore lint/complexity/useOptionalChain: internal is dereferenced below — the "fix" would pass undefined onward
		if (!internal || internal.record.status !== "active") return;
		this.raise(internal, {
			kind: "expired",
			summary: `watch expired after its ${Math.round(
				internal.record.caps.maxDurationMs / 60_000,
			)}m budget without triggering`,
		});
		this.end(internal, "expired", "duration cap reached");
	}

	/** Public for tests: force the expiry path without waiting on the timer. */
	async forceExpire(id: string): Promise<void> {
		return this.expire(id);
	}

	private raise(
		internal: WatchInternal,
		raise: { kind: WatchRaise["kind"]; summary: string },
	): void {
		const history = internal.record.refinements.map((r) => r.rationale);
		this.deps.raise({
			watchId: internal.record.id,
			kind: raise.kind,
			summary: raise.summary,
			...(history.length > 0 ? { refinementHistory: history } : {}),
		});
	}

	private end(
		internal: WatchInternal,
		status: WatchStatus,
		reason: string,
	): void {
		if (internal.timer) clearInterval(internal.timer);
		if (internal.expiryTimer) clearTimeout(internal.expiryTimer);
		internal.record = {
			...internal.record,
			status,
			endReason: reason,
			endedAt: this.now(),
			updatedAt: this.now(),
		};
	}

	private async modelCall(
		ctx: ExtensionContext,
		prompt: string,
		timeoutMs: number,
	): Promise<string | null> {
		if (this.deps.modelCall) return this.deps.modelCall(ctx, prompt, timeoutMs);
		try {
			const row = policyRowFor(readPolicyTable(ctx.cwd), "tool:watch");
			if (row?.run.enabled === false) return null;
			const resolved = await resolveV2Model(ctx, {
				agent: "explorer",
				tier: row?.run.models ?? "light",
			});
			const auth = await resolveModelAuth(ctx, resolved.modelId);
			if (!auth) return null;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			try {
				const response = await complete(
					auth.model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						...(auth.headers ? { headers: auth.headers } : {}),
						maxTokens: MAX_MODEL_TOKENS,
						signal: controller.signal,
					},
				);
				return response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			} finally {
				clearTimeout(timer);
			}
		} catch {
			return null;
		}
	}
}

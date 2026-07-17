import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenSnapshot, UsageSource } from "@vegardx/pi-contracts";
import { UsageLedger } from "../../packages/modes/src/usage-ledger.js";

export interface ScenarioEvent {
	readonly sequence: number;
	readonly at: number;
	readonly type: string;
	readonly data?: unknown;
}

export class ScenarioClock {
	constructor(private value = Date.parse("2026-01-01T00:00:00.000Z")) {}

	now = (): number => this.value;
	iso = (): string => new Date(this.value).toISOString();

	advance(ms: number): number {
		if (!Number.isFinite(ms) || ms < 0)
			throw new Error("clock advance must be non-negative");
		this.value += ms;
		return this.value;
	}
}

export interface ScriptedModelTurn {
	readonly match?: string | RegExp | ((prompt: string) => boolean);
	readonly response: string;
	readonly usage?: Partial<TokenSnapshot>;
}

export interface ScriptedModelCall {
	readonly model: string;
	readonly prompt: string;
	readonly response: string;
	readonly usage?: Partial<TokenSnapshot>;
}

/** Strict FIFO fake: unexpected prompts and unused turns fail the scenario. */
export class ScriptedModels {
	readonly calls: ScriptedModelCall[] = [];
	private readonly scripts = new Map<string, ScriptedModelTurn[]>();

	constructor(
		scripts: Readonly<Record<string, readonly ScriptedModelTurn[]>> = {},
		private readonly emit: (type: string, data?: unknown) => void = () => {},
	) {
		for (const [model, turns] of Object.entries(scripts))
			this.scripts.set(model, [...turns]);
	}

	async complete(model: string, prompt: string): Promise<ScriptedModelCall> {
		const turn = this.scripts.get(model)?.shift();
		if (!turn) throw new Error(`no scripted response remains for ${model}`);
		if (!matches(turn.match, prompt))
			throw new Error(`script for ${model} rejected prompt: ${prompt}`);
		const call: ScriptedModelCall = {
			model,
			prompt,
			response: turn.response,
			...(turn.usage ? { usage: turn.usage } : {}),
		};
		this.calls.push(call);
		this.emit("model.completed", {
			model,
			call: this.calls.length,
			prompt,
			response: turn.response,
		});
		return call;
	}

	assertExhausted(): void {
		const pending = [...this.scripts.entries()].filter(
			([, turns]) => turns.length > 0,
		);
		if (pending.length)
			throw new Error(
				`unused scripted model turns: ${pending.map(([id, turns]) => `${id}=${turns.length}`).join(", ")}`,
			);
	}

	snapshot(): unknown {
		return {
			calls: this.calls,
			remaining: Object.fromEntries(
				[...this.scripts].map(([id, turns]) => [id, turns.length]),
			),
		};
	}
}

function matches(match: ScriptedModelTurn["match"], prompt: string): boolean {
	if (match === undefined) return true;
	if (typeof match === "string") return prompt.includes(match);
	if (match instanceof RegExp) return match.test(prompt);
	return match(prompt);
}

export interface FakePullRequest {
	readonly number: number;
	readonly branch: string;
	readonly title: string;
	readonly body: string;
	readonly state: "OPEN" | "MERGED" | "CLOSED";
}

export class ScenarioGitHub {
	private nextNumber = 1;
	private readonly prs = new Map<number, FakePullRequest>();

	constructor(private readonly emit: (type: string, data?: unknown) => void) {}

	upsert(input: {
		branch: string;
		title: string;
		body: string;
	}): FakePullRequest {
		const existing = [...this.prs.values()].find(
			(pr) => pr.branch === input.branch,
		);
		const pr: FakePullRequest = existing
			? { ...existing, title: input.title, body: input.body }
			: { ...input, number: this.nextNumber++, state: "OPEN" };
		this.prs.set(pr.number, pr);
		this.emit(existing ? "github.pr-updated" : "github.pr-created", pr);
		return pr;
	}

	setState(number: number, state: FakePullRequest["state"]): void {
		const current = this.prs.get(number);
		if (!current) throw new Error(`unknown fake PR #${number}`);
		this.prs.set(number, { ...current, state });
		this.emit("github.pr-state", { number, state });
	}

	list(): readonly FakePullRequest[] {
		return [...this.prs.values()];
	}
}

export interface FakeTmuxSession {
	readonly name: string;
	readonly cwd: string;
	readonly command: string;
	readonly createdAt: number;
	readonly stoppedAt?: number;
}

/** Process-free tmux seam for state-machine scenarios. Real-process tests use FakeTmux. */
export class ScenarioTmux {
	private readonly sessions = new Map<string, FakeTmuxSession>();

	constructor(
		private readonly clock: ScenarioClock,
		private readonly emit: (type: string, data?: unknown) => void,
	) {}

	async spawn(name: string, cwd: string, command: string): Promise<void> {
		if (await this.hasSession(name))
			throw new Error(`duplicate tmux session ${name}`);
		const session = { name, cwd, command, createdAt: this.clock.now() };
		this.sessions.set(name, session);
		this.emit("tmux.spawned", session);
	}

	async hasSession(name: string): Promise<boolean> {
		const session = this.sessions.get(name);
		return session !== undefined && session.stoppedAt === undefined;
	}

	async kill(name: string): Promise<void> {
		const session = this.sessions.get(name);
		if (!session || session.stoppedAt !== undefined)
			throw new Error(`no live tmux session ${name}`);
		const stopped = { ...session, stoppedAt: this.clock.now() };
		this.sessions.set(name, stopped);
		this.emit("tmux.killed", stopped);
	}

	list(): readonly FakeTmuxSession[] {
		return [...this.sessions.values()];
	}
}

export interface ScenarioContext {
	readonly root: string;
	readonly repo: string;
	readonly artifacts: string;
	readonly clock: ScenarioClock;
	readonly models: ScriptedModels;
	readonly github: ScenarioGitHub;
	readonly tmux: ScenarioTmux;
	readonly usage: UsageLedger;
	readonly state: Map<string, unknown>;
	emit(type: string, data?: unknown): void;
	recordUsage(source: UsageSource, snapshot: Partial<TokenSnapshot>): void;
	git(...args: string[]): string;
}

export interface ScenarioStep {
	readonly name: string;
	run(context: ScenarioContext): void | Promise<void>;
}

export interface ScenarioDefinition {
	readonly name: string;
	readonly models?: Readonly<Record<string, readonly ScriptedModelTurn[]>>;
	readonly keepArtifacts?: boolean;
	readonly steps: readonly ScenarioStep[];
	readonly finalState?: (context: ScenarioContext) => unknown;
}

export interface ScenarioResult {
	readonly name: string;
	readonly root: string;
	readonly repo: string;
	readonly artifacts: string;
	readonly events: readonly ScenarioEvent[];
	readonly finalState: unknown;
	cleanup(): void;
}

/**
 * Runs named steps in a fresh git repository and always writes events.jsonl plus
 * final-state.json. The error artifact is written before a failed step rethrows.
 */
export async function runScenario(
	definition: ScenarioDefinition,
): Promise<ScenarioResult> {
	const root = mkdtempSync(
		join(tmpdir(), `maestro-scenario-${slug(definition.name)}-`),
	);
	const repo = join(root, "repo");
	const artifacts = join(root, "artifacts");
	mkdirSync(repo);
	mkdirSync(artifacts);
	initRepo(repo);
	const clock = new ScenarioClock();
	const events: ScenarioEvent[] = [];
	const eventPath = join(artifacts, "events.jsonl");
	const emit = (type: string, data?: unknown) => {
		const event: ScenarioEvent = {
			sequence: events.length + 1,
			at: clock.now(),
			type,
			...(data === undefined ? {} : { data: serializable(data) }),
		};
		events.push(event);
		appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
	};
	const models = new ScriptedModels(definition.models, emit);
	const usage = new UsageLedger({
		now: clock.now,
		onAccepted: (value) => emit("usage.accepted", value),
	});
	const context: ScenarioContext = {
		root,
		repo,
		artifacts,
		clock,
		models,
		github: new ScenarioGitHub(emit),
		tmux: new ScenarioTmux(clock, emit),
		usage,
		state: new Map(),
		emit,
		recordUsage: (source, snapshot) => usage.record(source, snapshot),
		git: (...args) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(),
	};
	let finalState: unknown;
	try {
		emit("scenario.started", { name: definition.name });
		for (const step of definition.steps) {
			emit("step.started", { name: step.name });
			await step.run(context);
			emit("step.completed", { name: step.name });
		}
		models.assertExhausted();
		finalState = serializable(
			definition.finalState?.(context) ?? defaultFinalState(context),
		);
		emit("scenario.completed", { name: definition.name });
		writeFileSync(
			join(artifacts, "final-state.json"),
			JSON.stringify(finalState, null, 2),
		);
	} catch (error) {
		emit("scenario.failed", {
			name: definition.name,
			error: error instanceof Error ? error.message : String(error),
		});
		writeFileSync(
			join(artifacts, "error.json"),
			JSON.stringify(
				{
					name: definition.name,
					error:
						error instanceof Error
							? { name: error.name, message: error.message, stack: error.stack }
							: String(error),
					events,
				},
				null,
				2,
			),
		);
		if (!definition.keepArtifacts)
			rmSync(root, { recursive: true, force: true });
		throw error;
	}
	return {
		name: definition.name,
		root,
		repo,
		artifacts,
		events,
		finalState,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function defaultFinalState(context: ScenarioContext): unknown {
	return {
		state: Object.fromEntries(context.state),
		models: context.models.snapshot(),
		github: context.github.list(),
		tmux: context.tmux.list(),
		usage: context.usage.snapshot(),
		head: context.git("rev-parse", "HEAD"),
		status: context.git("status", "--porcelain"),
	};
}

function initRepo(repo: string): void {
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "scenario@example.invalid"], {
		cwd: repo,
	});
	execFileSync("git", ["config", "user.name", "Scenario Harness"], {
		cwd: repo,
	});
	writeFileSync(join(repo, "README.md"), "# Scenario repository\n");
	execFileSync("git", ["add", "README.md"], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "chore: initialize scenario"], {
		cwd: repo,
	});
}

function serializable(value: unknown): unknown {
	return JSON.parse(
		JSON.stringify(value, (_key, nested) =>
			nested instanceof Map ? Object.fromEntries(nested) : nested,
		),
	);
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 32) || "test"
	);
}

export const scenarioAssertions = {
	eventTypes(
		result: Pick<ScenarioResult, "events">,
		expected: readonly string[],
	): void {
		const actual = result.events.map((event) => event.type);
		if (JSON.stringify(actual) !== JSON.stringify(expected))
			throw new Error(
				`event sequence mismatch\nexpected: ${expected.join(" -> ")}\nactual:   ${actual.join(" -> ")}`,
			);
	},
	hasEvent(
		result: Pick<ScenarioResult, "events">,
		type: string,
		predicate?: (data: unknown) => boolean,
	): ScenarioEvent {
		const event = result.events.find(
			(candidate) =>
				candidate.type === type && (!predicate || predicate(candidate.data)),
		);
		if (!event) throw new Error(`missing scenario event ${type}`);
		return event;
	},
	artifact(result: Pick<ScenarioResult, "artifacts">, name: string): unknown {
		const path = join(result.artifacts, name);
		if (!existsSync(path)) throw new Error(`missing scenario artifact ${name}`);
		return JSON.parse(readFileSync(path, "utf8"));
	},
	cleanRepo(context: ScenarioContext): void {
		const status = context.git("status", "--porcelain");
		if (status) throw new Error(`scenario repository is dirty:\n${status}`);
	},
};

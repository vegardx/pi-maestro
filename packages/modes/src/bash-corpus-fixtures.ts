import { createHash } from "node:crypto";
import type { BashCorpusCall } from "./bash-corpus.js";
import {
	classifyCorpusCommand,
	type ParserFeature,
} from "./bash-corpus-taxonomy.js";

export type FixturePartition = "training" | "holdout";

export interface SanitizedBashFixture {
	readonly id: string;
	readonly sourceId: string;
	readonly partition: FixturePartition;
	readonly command: string;
	readonly family: string;
	readonly features: readonly ParserFeature[];
	readonly variant?: ParserFeature;
}

export interface FixtureSet {
	readonly version: 1;
	readonly holdoutStart: string | null;
	readonly training: readonly SanitizedBashFixture[];
	readonly holdout: readonly SanitizedBashFixture[];
	readonly adversarial: readonly SanitizedBashFixture[];
}

export interface FixtureOptions {
	/** Explicit UTC boundary. If absent, the newest whole percentage is held out. */
	readonly holdoutStart?: string;
	readonly holdoutFraction?: number;
	readonly maxPerPartition?: number;
	readonly adversarialPerSource?: number;
}

const ADVERSARIAL: readonly {
	feature: ParserFeature;
	apply(command: string): string;
}[] = [
	{ feature: "chain", apply: (command) => `${command} && printf '%s\\n' done` },
	{ feature: "pipeline", apply: (command) => `${command} | cat` },
	{
		feature: "redirect",
		apply: (command) => `${command} > ./fixture-output.txt`,
	},
	{ feature: "heredoc", apply: () => "cat <<'FIXTURE'\nfixture text\nFIXTURE" },
	{
		feature: "substitution",
		apply: () => "printf '%s\\n' \"$(printf fixture)\"",
	},
	{
		feature: "wrapper",
		apply: (command) => `env sh -c ${shellQuote(command)}`,
	},
	{
		feature: "environment-prefix",
		apply: (command) => `FIXTURE_MODE=1 ${command}`,
	},
	{
		feature: "git-extensibility",
		apply: () =>
			"git -C ./fixture-repo -c alias.fixture=status fixture --short",
	},
	{
		feature: "remote-api",
		apply: () =>
			"curl -X PATCH -d '{\"enabled\":true}' https://example.invalid/api/resource",
	},
];

/**
 * Build sanitized fixtures. Historical commands are reduced to allowlisted
 * tokens and placeholders; holdout membership is based only on timestamps.
 */
export function buildCorpusFixtures(
	calls: readonly BashCorpusCall[],
	options: FixtureOptions = {},
): FixtureSet {
	const sorted = [...calls].sort(compareChronologically);
	const dated = sorted.filter(
		(call) => parseTimestamp(call.timestamp ?? call.sessionTimestamp) !== null,
	);
	const boundary = resolveBoundary(dated, options);
	const maxPerPartition = Math.max(0, options.maxPerPartition ?? 200);
	const training: SanitizedBashFixture[] = [];
	const holdout: SanitizedBashFixture[] = [];

	for (const call of sorted) {
		const callTime = parseTimestamp(call.timestamp ?? call.sessionTimestamp);
		const partition =
			boundary !== null && callTime !== null && callTime >= boundary
				? "holdout"
				: "training";
		const target = partition === "holdout" ? holdout : training;
		if (target.length >= maxPerPartition) continue;
		const command = sanitizeCommand(call.command);
		const taxonomy = classifyCorpusCommand(command, call.commandTruncated);
		target.push({
			id: fixtureId(call.id, partition, command),
			sourceId: call.id,
			partition,
			command,
			family: taxonomy.family,
			features: taxonomy.features,
		});
	}

	const adversarial: SanitizedBashFixture[] = [];
	const sourceLimit = Math.max(
		0,
		options.adversarialPerSource ?? ADVERSARIAL.length,
	);
	for (const fixture of training) {
		for (const variant of ADVERSARIAL.slice(0, sourceLimit)) {
			const command = variant.apply(fixture.command);
			const taxonomy = classifyCorpusCommand(command);
			adversarial.push({
				id: fixtureId(fixture.id, variant.feature, command),
				sourceId: fixture.sourceId,
				partition: "training",
				command,
				family: taxonomy.family,
				features: taxonomy.features,
				variant: variant.feature,
			});
		}
	}

	return {
		version: 1,
		holdoutStart: boundary !== null ? new Date(boundary).toISOString() : null,
		training,
		holdout,
		adversarial,
	};
}

/** Remove secrets, host paths, URLs, free-form arguments, and shell payloads. */
export function sanitizeCommand(command: string): string {
	const firstLine = command.split(/\r?\n/u, 1)[0] ?? "";
	const tokens = tokenize(firstLine).slice(0, 16);
	if (tokens.length === 0) return "fixture-command";
	return tokens
		.map((token, index) => sanitizeToken(token, index))
		.join(" ")
		.slice(0, 512);
}

function sanitizeToken(token: string, index: number): string {
	const bare = token.replace(/^['"]|['"]$/gu, "");
	if (index === 0 && /^[A-Za-z][\w.-]*$/u.test(bare))
		return safeExecutable(bare);
	if (/^(?:&&|\|\||\||;|>|>>|<)$/u.test(bare)) return bare;
	if (/^-[A-Za-z0-9][\w-]*$/u.test(bare)) return bare.slice(0, 40);
	if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(bare))
		return `${bare.split("=", 1)[0]}=FIXTURE`;
	if (
		/^(?:status|diff|log|show|branch|rev-parse|ls-files|cat-file|add|commit|test|run|check|build)$/u.test(
			bare,
		)
	)
		return bare;
	if (/^https?:\/\//u.test(bare)) return "https://example.invalid/resource";
	if (/^\d+$/u.test(bare)) return "1";
	if (/\.(?:ts|js|json|md|txt|mjs|cjs)$/u.test(bare))
		return `./fixture${bare.slice(bare.lastIndexOf("."))}`;
	return "FIXTURE";
}

function safeExecutable(value: string): string {
	const allowed = new Set([
		"git",
		"npm",
		"npx",
		"pnpm",
		"yarn",
		"bun",
		"node",
		"python",
		"python3",
		"bash",
		"sh",
		"cat",
		"head",
		"tail",
		"grep",
		"rg",
		"find",
		"ls",
		"pwd",
		"wc",
		"curl",
		"wget",
		"gh",
		"make",
		"cargo",
		"go",
		"printf",
	]);
	return allowed.has(value) ? value : "fixture-command";
}

function tokenize(value: string): string[] {
	return value.match(/&&|\|\||>>|[|;<>]|"[^"]*"|'[^']*'|[^\s|;<>]+/gu) ?? [];
}

function resolveBoundary(
	calls: readonly BashCorpusCall[],
	options: FixtureOptions,
): number | null {
	if (options.holdoutStart !== undefined) {
		const explicit = Date.parse(options.holdoutStart);
		if (!Number.isFinite(explicit))
			throw new Error("holdoutStart must be a valid timestamp");
		return explicit;
	}
	if (calls.length === 0) return null;
	const fraction = Math.min(0.9, Math.max(0, options.holdoutFraction ?? 0.2));
	if (fraction === 0) return null;
	const index = Math.max(0, Math.floor(calls.length * (1 - fraction)));
	return (
		parseTimestamp(
			calls[Math.min(index, calls.length - 1)].timestamp ??
				calls[Math.min(index, calls.length - 1)].sessionTimestamp,
		) ?? null
	);
}

function compareChronologically(a: BashCorpusCall, b: BashCorpusCall): number {
	const aTime =
		parseTimestamp(a.timestamp ?? a.sessionTimestamp) ??
		Number.NEGATIVE_INFINITY;
	const bTime =
		parseTimestamp(b.timestamp ?? b.sessionTimestamp) ??
		Number.NEGATIVE_INFINITY;
	if (aTime !== bTime) return aTime - bTime;
	return a.id.localeCompare(b.id);
}

function parseTimestamp(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function fixtureId(source: string, kind: string, command: string): string {
	return createHash("sha256")
		.update(`${source}\0${kind}\0${command}`)
		.digest("hex")
		.slice(0, 24);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

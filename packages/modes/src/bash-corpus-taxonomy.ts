import { createHash } from "node:crypto";
import type { BashCorpusCall, CorpusActor, CorpusMode } from "./bash-corpus.js";

export type CommandFamily =
	| "filesystem-read"
	| "filesystem-write"
	| "git-read"
	| "git-write"
	| "package-exec"
	| "remote-read"
	| "remote-mutation"
	| "shell-orchestration"
	| "interpreter"
	| "other";

export type ParserFeature =
	| "chain"
	| "pipeline"
	| "redirect"
	| "heredoc"
	| "substitution"
	| "wrapper"
	| "environment-prefix"
	| "git-extensibility"
	| "remote-api";

export interface CommandTaxonomy {
	readonly family: CommandFamily;
	readonly features: readonly ParserFeature[];
	readonly uncertain: boolean;
	readonly uncertaintyReasons: readonly string[];
}

export interface TaxonomyReport {
	readonly version: 1;
	readonly total: number;
	readonly counts: {
		readonly families: Readonly<Record<CommandFamily, number>>;
		readonly features: Readonly<Partial<Record<ParserFeature, number>>>;
		readonly modes: Readonly<Partial<Record<CorpusMode, number>>>;
		readonly actors: Readonly<Partial<Record<CorpusActor, number>>>;
	};
	readonly representatives: readonly TaxonomyRepresentative[];
	readonly uncertain: readonly TaxonomyRepresentative[];
	readonly omitted: {
		readonly representatives: number;
		readonly uncertain: number;
	};
}

export interface TaxonomyRepresentative {
	readonly callId: string;
	readonly family: CommandFamily;
	readonly features: readonly ParserFeature[];
	/** A synthetic, inert example. Historical command text is never reported. */
	readonly example: string;
	readonly reasons?: readonly string[];
}

export interface TaxonomyReportOptions {
	readonly maxRepresentatives?: number;
	readonly maxUncertain?: number;
}

const FAMILY_EXAMPLES: Readonly<Record<CommandFamily, string>> = {
	"filesystem-read": "cat ./example.txt",
	"filesystem-write": "mkdir ./example-output",
	"git-read": "git status --short",
	"git-write": "git add ./example.txt",
	"package-exec": "npm test",
	"remote-read": "curl https://example.invalid/status",
	"remote-mutation": "curl -X POST https://example.invalid/resource",
	"shell-orchestration": "printf sample && printf done",
	interpreter: "node ./example-script.js",
	other: "example-command --flag",
};

const FAMILIES: readonly CommandFamily[] = Object.keys(
	FAMILY_EXAMPLES,
) as CommandFamily[];

/** Conservative lexical taxonomy. It labels text only and never invokes a parser or shell. */
export function classifyCorpusCommand(
	command: string,
	truncated = false,
): CommandTaxonomy {
	const features: ParserFeature[] = [];
	if (/&&|\|\||(^|[^;]);(?:;)?/u.test(command)) features.push("chain");
	if (/(^|[^|])\|([^|]|$)/u.test(command)) features.push("pipeline");
	if (/(^|\s)(?:\d*>>?|\d*<)(?!<)/u.test(command)) features.push("redirect");
	if (/<<-?\s*['"]?[A-Za-z_][\w-]*/u.test(command)) features.push("heredoc");
	if (/\$\(|`[^`]*`|<\(|>\(/u.test(command)) features.push("substitution");
	if (
		/^\s*(?:sudo|env|command|builtin|xargs|find\b[^\n]*\s-exec\b|sh\s+-c\b|bash\s+-c\b)/u.test(
			command,
		)
	)
		features.push("wrapper");
	if (/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/u.test(command))
		features.push("environment-prefix");
	if (
		/\bgit\s+(?:-C|-c|--git-dir|--work-tree)\b/u.test(command) ||
		/\bgit\s+[^\n]*(?:alias\.|upload-pack|receive-pack|remote-)\b/u.test(
			command,
		)
	)
		features.push("git-extensibility");
	if (/\b(?:curl|wget|gh\s+api)\b/u.test(command)) features.push("remote-api");

	const normalized = command
		.trim()
		.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/u, "");
	const family = classifyFamily(normalized, features);
	const uncertaintyReasons: string[] = [];
	if (truncated) uncertaintyReasons.push("command-truncated");
	if (hasUnbalancedQuotes(command))
		uncertaintyReasons.push("unbalanced-quotes");
	if (/\b(?:eval|source|\.)\s/u.test(command))
		uncertaintyReasons.push("runtime-code-loading");
	if (/\b(?:for|while|until|case|function)\b|\{[\s\S]*\}/u.test(command))
		uncertaintyReasons.push("compound-shell-grammar");
	if (family === "other") uncertaintyReasons.push("unknown-command-family");

	return {
		family,
		features,
		uncertain: uncertaintyReasons.length > 0,
		uncertaintyReasons,
	};
}

export function buildTaxonomyReport(
	calls: readonly BashCorpusCall[],
	options: TaxonomyReportOptions = {},
): TaxonomyReport {
	const maxRepresentatives = Math.max(0, options.maxRepresentatives ?? 24);
	const maxUncertain = Math.max(0, options.maxUncertain ?? 50);
	const families = Object.fromEntries(
		FAMILIES.map((family) => [family, 0]),
	) as Record<CommandFamily, number>;
	const featureCounts: Partial<Record<ParserFeature, number>> = {};
	const modes: Partial<Record<CorpusMode, number>> = {};
	const actors: Partial<Record<CorpusActor, number>> = {};
	const candidates: TaxonomyRepresentative[] = [];
	const uncertainCandidates: TaxonomyRepresentative[] = [];

	for (const call of [...calls].sort((a, b) => a.id.localeCompare(b.id))) {
		const taxonomy = classifyCorpusCommand(call.command, call.commandTruncated);
		families[taxonomy.family]++;
		modes[call.mode] = (modes[call.mode] ?? 0) + 1;
		actors[call.actor] = (actors[call.actor] ?? 0) + 1;
		for (const feature of taxonomy.features)
			featureCounts[feature] = (featureCounts[feature] ?? 0) + 1;
		const representative: TaxonomyRepresentative = {
			callId: call.id,
			family: taxonomy.family,
			features: taxonomy.features,
			example: FAMILY_EXAMPLES[taxonomy.family],
			...(taxonomy.uncertain ? { reasons: taxonomy.uncertaintyReasons } : {}),
		};
		candidates.push(representative);
		if (taxonomy.uncertain) uncertainCandidates.push(representative);
	}

	const representatives = distinctBy(
		candidates,
		(item) => `${item.family}:${item.features.join(",")}`,
	).slice(0, maxRepresentatives);
	const uncertain = uncertainCandidates.slice(0, maxUncertain);
	return {
		version: 1,
		total: calls.length,
		counts: { families, features: featureCounts, modes, actors },
		representatives,
		uncertain,
		omitted: {
			representatives: Math.max(
				0,
				distinctBy(
					candidates,
					(item) => `${item.family}:${item.features.join(",")}`,
				).length - representatives.length,
			),
			uncertain: Math.max(0, uncertainCandidates.length - uncertain.length),
		},
	};
}

function classifyFamily(
	command: string,
	features: readonly ParserFeature[],
): CommandFamily {
	if (
		features.includes("chain") ||
		features.includes("pipeline") ||
		features.includes("heredoc") ||
		/\b(?:for|while|until|case)\b/u.test(command)
	)
		return "shell-orchestration";
	if (/^git\b/u.test(command))
		return /\bgit\s+(?:status|diff|log|show|branch|rev-parse|ls-files|cat-file|remote\s+-v)\b/u.test(
			command,
		)
			? "git-read"
			: "git-write";
	if (/^(?:npm|npx|pnpm|yarn|bun|make|cargo|go\s+test)\b/u.test(command))
		return "package-exec";
	if (/^(?:node|python\d*|ruby|perl|deno|tsx|sh|bash|zsh)\b/u.test(command))
		return "interpreter";
	if (/^(?:curl|wget|gh\s+api)\b/u.test(command))
		return /(?:^|\s)(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-d|--data(?:-raw|-binary)?|-F|--form)(?:\s|=)/iu.test(
			command,
		)
			? "remote-mutation"
			: "remote-read";
	if (
		/^(?:cat|head|tail|sed\s+-n|grep|rg|find|ls|pwd|wc|stat|file)\b/u.test(
			command,
		)
	)
		return "filesystem-read";
	if (
		/^(?:cp|mv|rm|mkdir|touch|chmod|chown|install|tee)\b/u.test(command) ||
		features.includes("redirect")
	)
		return "filesystem-write";
	return "other";
}

function hasUnbalancedQuotes(command: string): boolean {
	let single = false;
	let double = false;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && !single) {
			escaped = true;
			continue;
		}
		if (char === "'" && !double) single = !single;
		if (char === '"' && !single) double = !double;
	}
	return single || double;
}

function distinctBy<T>(values: readonly T[], key: (value: T) => string): T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const itemKey = key(value);
		if (seen.has(itemKey)) return false;
		seen.add(itemKey);
		return true;
	});
}

export function taxonomyDigest(report: TaxonomyReport): string {
	return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

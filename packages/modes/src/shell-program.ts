export type ShellFeature =
	| "chain"
	| "pipeline"
	| "redirect"
	| "heredoc"
	| "substitution"
	| "grouping"
	| "background"
	| "wrapper"
	| "environment-prefix"
	| "interpreter-carrier"
	| "git-extensibility"
	| "opaque-dispatch";

export interface ShellSimpleCommand {
	readonly source: string;
	readonly words: readonly string[];
	readonly executable?: string;
	readonly args: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly wrappers: readonly string[];
	readonly opaque: boolean;
}

export interface ShellProgramAnalysis {
	readonly source: string;
	readonly commands: readonly ShellSimpleCommand[];
	readonly features: ReadonlySet<ShellFeature>;
	readonly completeSimple: boolean;
	readonly parseComplete: boolean;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const INTERPRETERS = new Set([
	...SHELLS,
	"node",
	"deno",
	"bun",
	"python",
	"python2",
	"python3",
	"ruby",
	"perl",
	"php",
]);
const WRAPPERS = new Set([
	"env",
	"command",
	"exec",
	"nice",
	"nohup",
	"time",
	"timeout",
	"sudo",
	"doas",
]);
const OPAQUE = new Set(["eval", "xargs", "parallel", "make", "just", "task"]);

interface LexResult {
	words: string[];
	segments: string[];
	operators: string[];
	features: Set<ShellFeature>;
	parseComplete: boolean;
}

/**
 * Lex enough shell structure to make conservative routing decisions. This is
 * deliberately not an authorising shell parser: unsupported syntax lowers
 * parseComplete or marks the command opaque, which can only narrow routing.
 */
export function analyzeShellProgram(source: string): ShellProgramAnalysis {
	const lexed = lex(source);
	const commands = lexed.segments
		.map((segment) => parseSimple(segment, lexed.features))
		.filter((command): command is ShellSimpleCommand => command !== undefined);
	const completeSimple =
		commands.length === 1 &&
		lexed.operators.length === 0 &&
		lexed.features.size === 0 &&
		lexed.parseComplete &&
		!commands[0].opaque;
	return {
		source,
		commands,
		features: lexed.features,
		completeSimple,
		parseComplete: lexed.parseComplete && commands.length > 0,
	};
}

function lex(source: string): LexResult {
	const words: string[] = [];
	const segments: string[] = [];
	const operators: string[] = [];
	const features = new Set<ShellFeature>();
	let word = "";
	let segment = "";
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let parseComplete = true;
	const flushWord = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	const flushSegment = () => {
		flushWord();
		if (segment.trim() !== "") segments.push(segment.trim());
		segment = "";
	};
	const operator = (value: string, feature: ShellFeature, split: boolean) => {
		flushWord();
		features.add(feature);
		operators.push(value);
		if (split) flushSegment();
		else segment += value;
	};

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		const next = source[index + 1] ?? "";
		if (escaped) {
			segment += char;
			word += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			segment += char;
			escaped = true;
			continue;
		}
		if (quote) {
			segment += char;
			if (quote === "`" && char === "`") {
				features.add("substitution");
				quote = undefined;
				continue;
			}
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (quote === '"' && char === "$" && (next === "(" || next === "{")) {
				features.add("substitution");
			}
			word += char;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			segment += char;
			quote = char;
			if (char === "`") features.add("substitution");
			continue;
		}
		if (char === "$" && (next === "(" || next === "{")) {
			segment += char;
			features.add("substitution");
			word += char;
			continue;
		}
		if ((char === "<" || char === ">") && next === "(") {
			features.add("substitution");
			operator(char, "redirect", false);
			continue;
		}
		if (char === "&" && next === "&") {
			operator("&&", "chain", true);
			index += 1;
			continue;
		}
		if (char === "|" && next === "|") {
			operator("||", "chain", true);
			index += 1;
			continue;
		}
		if (char === "|") {
			operator("|", "pipeline", true);
			continue;
		}
		if (char === ";" || char === "\n") {
			operator(char, "chain", true);
			continue;
		}
		if (char === "&") {
			operator("&", "background", true);
			continue;
		}
		if (char === ">" || char === "<") {
			const heredoc = char === "<" && next === "<";
			operator(char, heredoc ? "heredoc" : "redirect", false);
			if (next === char) {
				segment += next;
				index += 1;
			}
			continue;
		}
		if (char === "(" || char === ")" || char === "{" || char === "}") {
			segment += char;
			features.add("grouping");
			word += char;
			continue;
		}
		if (/\s/u.test(char)) {
			segment += char;
			flushWord();
			continue;
		}
		segment += char;
		word += char;
	}
	flushSegment();
	if (quote || escaped) parseComplete = false;
	if (source.trim() === "") parseComplete = true;
	return { words, segments, operators, features, parseComplete };
}

function parseSimple(
	source: string,
	features: Set<ShellFeature>,
): ShellSimpleCommand | undefined {
	const words = tokenizeWords(source);
	if (words.length === 0) return undefined;
	const environment: Record<string, string> = {};
	let index = 0;
	while (index < words.length && ASSIGNMENT.test(words[index] ?? "")) {
		const assignment = words[index] ?? "";
		const split = assignment.indexOf("=");
		environment[assignment.slice(0, split)] = assignment.slice(split + 1);
		index += 1;
	}
	if (index > 0) features.add("environment-prefix");
	const wrappers: string[] = [];
	while (WRAPPERS.has(words[index] ?? "")) {
		const wrapper = words[index] ?? "";
		wrappers.push(wrapper);
		features.add("wrapper");
		index += 1;
		if (wrapper === "env") {
			while (
				index < words.length &&
				(ASSIGNMENT.test(words[index] ?? "") ||
					(words[index] ?? "").startsWith("-"))
			)
				index += 1;
		} else {
			while (index < words.length && (words[index] ?? "").startsWith("-"))
				index += 1;
		}
	}
	const executable = words[index];
	const args = words.slice(index + 1);
	let opaque = executable === undefined;
	if (executable && OPAQUE.has(executable)) {
		features.add("opaque-dispatch");
		opaque = true;
	}
	if (executable && INTERPRETERS.has(executable)) {
		const carrier =
			(SHELLS.has(executable) &&
				args.some((arg) => arg === "-c" || arg.includes("c"))) ||
			args.some((arg) => ["-c", "-e", "--eval", "--execute"].includes(arg)) ||
			features.has("heredoc");
		if (carrier) {
			features.add("interpreter-carrier");
			opaque = true;
		}
	}
	if (executable === "git") {
		const extensible =
			args.some((arg) => arg === "-c" || arg.startsWith("--config-env")) ||
			args.some((arg) => /^(?:alias|core\.hooksPath|pager)\./u.test(arg)) ||
			args.some((arg) => arg.startsWith("!") || arg === "credential");
		if (extensible) {
			features.add("git-extensibility");
			opaque = true;
		}
	}
	if (args.some((arg) => arg === "-exec" || arg === "-execdir")) {
		features.add("opaque-dispatch");
		opaque = true;
	}
	return { source, words, executable, args, environment, wrappers, opaque };
}

function tokenizeWords(source: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const flush = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	for (const char of source) {
		if (escaped) {
			word += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) flush();
		else word += char;
	}
	flush();
	return words;
}

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractBashCorpusJsonl } from "../packages/modes/src/bash-corpus.js";
import {
	buildCorpusFixtures,
	sanitizeCommand,
} from "../packages/modes/src/bash-corpus-fixtures.js";
import {
	buildTaxonomyReport,
	classifyCorpusCommand,
	taxonomyDigest,
} from "../packages/modes/src/bash-corpus-taxonomy.js";
import {
	replayShadowPolicies,
	shadowBaselineDigest,
} from "../packages/modes/src/bash-shadow-replay.js";
import { buildAgentSessionFile } from "../packages/modes/src/exec/provisioner.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("historical bash corpus", () => {
	it("extracts metadata, mode, actor posture, nearby tools, and outcome", () => {
		const corpus = extractBashCorpusJsonl(
			jsonl(
				{
					type: "session",
					id: "session-1",
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: "/workspace",
				},
				{
					type: "custom",
					customType: "maestro.modes.state",
					data: { mode: "agent" },
				},
				{
					type: "custom",
					customType: "maestro.agent.context",
					data: {
						role: "reviewer",
						posture: "read-only",
						activeTools: ["read", "bash", "read"],
					},
				},
				assistantCall(
					"call-1",
					"git status --short",
					"2025-01-02T00:00:00.000Z",
				),
				toolResult("call-1", false, 0),
			),
		);

		expect(corpus.diagnostics).toEqual([]);
		expect(corpus.calls).toHaveLength(1);
		expect(corpus.calls[0]).toMatchObject({
			sessionId: "session-1",
			cwd: "/workspace",
			command: "git status --short",
			mode: "agent",
			actor: "reviewer",
			posture: "read-only",
			nearbyTools: ["bash", "read"],
			outcome: { status: "success", exitCode: 0 },
		});
	});

	it("extracts context persisted by real agent session provisioning", () => {
		const directory = mkdtempSync(join(tmpdir(), "maestro-agent-corpus-"));
		temporaryDirectories.push(directory);
		const session = buildAgentSessionFile({
			agentKey: "g1/reviewer",
			agentMode: "read-only",
			activeTools: ["read", "bash", "read"],
			seed: "review",
			cwd: directory,
			outDir: join(directory, "sessions"),
		});
		const source = `${readFileSync(session.path, "utf8")}${JSON.stringify(assistantCall("audit", "git status"))}\n`;
		const corpus = extractBashCorpusJsonl(source);
		expect(corpus.calls[0]).toMatchObject({
			mode: "agent",
			actor: "reviewer",
			posture: "read-only",
			nearbyTools: ["bash", "read"],
		});
	});

	it("continues past malformed JSONL and defaults missing mode metadata", () => {
		const input = `${JSON.stringify({ type: "session", id: "s", cwd: "/repo" })}\n{broken\n${JSON.stringify(assistantCall("c", "pwd"))}\n`;
		const first = extractBashCorpusJsonl(input);
		const second = extractBashCorpusJsonl(input);

		expect(first).toEqual(second);
		expect(first.diagnostics).toEqual([{ line: 2, code: "malformed-json" }]);
		expect(first.calls[0]).toMatchObject({
			mode: "unknown",
			actor: "maestro",
			posture: "unknown",
			outcome: { status: "missing" },
		});
	});

	it("keeps first duplicate calls and results deterministically", () => {
		const input = jsonl(
			{ type: "session", id: "s" },
			assistantCall("same", "printf first"),
			assistantCall("same", "printf second"),
			toolResult("same", false, 0),
			toolResult("same", true, 9),
		);
		const corpus = extractBashCorpusJsonl(input);

		expect(corpus.calls[0].command).toBe("printf first");
		expect(corpus.calls[0].outcome).toMatchObject({
			status: "success",
			exitCode: 0,
		});
		expect(corpus.diagnostics.map((item) => item.code)).toEqual([
			"duplicate-call",
			"duplicate-result",
		]);
	});

	it("bounds large UTF-8 commands without changing their byte accounting", () => {
		const command = `printf ${"å".repeat(100)}`;
		const corpus = extractBashCorpusJsonl(
			jsonl({ type: "session", id: "s" }, assistantCall("large", command)),
			{ maxCommandBytes: 17 },
		);

		expect(Buffer.byteLength(corpus.calls[0].command)).toBeLessThanOrEqual(17);
		expect(corpus.calls[0].commandBytes).toBe(Buffer.byteLength(command));
		expect(corpus.calls[0].commandTruncated).toBe(true);
		expect(corpus.calls[0].command).not.toContain("�");
	});

	it("never executes command text while extracting, classifying, or replaying", () => {
		const directory = mkdtempSync(join(tmpdir(), "maestro-corpus-"));
		temporaryDirectories.push(directory);
		const marker = join(directory, "must-not-exist");
		const command = `node -e "require('fs').writeFileSync('${marker}','bad')"`;
		const corpus = extractBashCorpusJsonl(
			jsonl({ type: "session", id: "s" }, assistantCall("danger", command)),
		);
		const policy = vi.fn(() => ({
			route: "deny" as const,
			reason: "shadow only",
		}));

		classifyCorpusCommand(corpus.calls[0].command);
		buildCorpusFixtures(corpus.calls);
		replayShadowPolicies(corpus.calls, [
			{ id: "test-policy", evaluate: policy },
		]);

		expect(policy).toHaveBeenCalledOnce();
		expect(existsSync(marker)).toBe(false);
	});

	it("emits bounded inert taxonomy reports without historical bodies", () => {
		const secret = "TOP_SECRET_TOKEN_123";
		const corpus = extractBashCorpusJsonl(
			jsonl(
				{ type: "session", id: "s" },
				assistantCall(
					"one",
					`curl -H 'Authorization: ${secret}' https://private.invalid/x`,
				),
				assistantCall("two", "eval $DYNAMIC"),
			),
		);
		const report = buildTaxonomyReport(corpus.calls, {
			maxRepresentatives: 1,
			maxUncertain: 1,
		});

		expect(report.total).toBe(2);
		expect(report.representatives).toHaveLength(1);
		expect(report.uncertain).toHaveLength(1);
		expect(JSON.stringify(report)).not.toContain(secret);
		expect(taxonomyDigest(report)).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("reserves a time holdout and covers every required adversarial shape", () => {
		const corpus = extractBashCorpusJsonl(
			jsonl(
				{ type: "session", id: "s" },
				assistantCall(
					"old",
					"cat /Users/person/private.txt",
					"2025-01-01T00:00:00.000Z",
				),
				assistantCall("new", "npm test", "2025-02-01T00:00:00.000Z"),
			),
		);
		const fixtures = buildCorpusFixtures(corpus.calls, {
			holdoutStart: "2025-02-01T00:00:00.000Z",
		});

		expect(fixtures.training).toHaveLength(1);
		expect(fixtures.holdout).toHaveLength(1);
		expect(fixtures.training[0].command).not.toContain("person");
		expect(new Set(fixtures.adversarial.map((item) => item.variant))).toEqual(
			new Set([
				"chain",
				"pipeline",
				"redirect",
				"heredoc",
				"substitution",
				"wrapper",
				"environment-prefix",
				"git-extensibility",
				"remote-api",
			]),
		);
		expect(JSON.stringify(fixtures)).not.toContain("/Users/person");
	});

	it("keeps sanitized commands out of both training and holdout", () => {
		const corpus = extractBashCorpusJsonl(
			jsonl(
				{ type: "session", id: "s" },
				assistantCall("old", "git status", "2025-01-01T00:00:00.000Z"),
				assistantCall("new", "git status", "2025-02-01T00:00:00.000Z"),
			),
		);
		const fixtures = buildCorpusFixtures(corpus.calls, {
			holdoutStart: "2025-02-01T00:00:00.000Z",
		});
		expect(fixtures.training).toHaveLength(1);
		expect(fixtures.holdout).toHaveLength(0);
		expect(fixtures.omitted.holdoutDuplicates).toBe(1);
	});

	it("produces stable bounded shadow baselines and fail-visible policy errors", () => {
		const corpus = extractBashCorpusJsonl(
			jsonl({ type: "session", id: "s" }, assistantCall("one", "git status")),
		);
		const policies = [
			{
				id: "baseline",
				evaluate: () => ({ route: "host-read" as const, reason: "read" }),
			},
			{
				id: "candidate",
				evaluate: () => {
					throw new TypeError("failure details are not persisted");
				},
			},
		];
		const report = replayShadowPolicies(corpus.calls, policies, {
			maxDecisions: 1,
			maxComparisons: 1,
		});

		expect(report.policies[1]).toMatchObject({ failures: 1 });
		expect(report.policies[1].routes.unknown).toBe(1);
		expect(report.comparisons).toEqual([
			{
				callId: corpus.calls[0].id,
				baselineRoute: "host-read",
				candidateRoute: "unknown",
			},
		]);
		expect(report.omitted.decisions).toBe(1);
		expect(shadowBaselineDigest(report)).toBe(shadowBaselineDigest(report));
	});

	it("sanitizes credentials, paths, URLs, and free-form values", () => {
		const sanitized = sanitizeCommand(
			"curl -H 'Authorization: bearer-secret' https://internal.example/api /Users/alice/key.pem",
		);
		expect(sanitized).toContain("https://example.invalid/resource");
		expect(sanitized).not.toMatch(/bearer-secret|internal\.example|alice/u);
		for (const secret of ["-pSUPERSECRET", "-ISECRET", "-kSECRET"]) {
			expect(
				sanitizeCommand(`curl ${secret} https://example.test`),
			).not.toContain("SECRET");
		}
	});

	it("recognizes unspaced redirects without treating quoted operators as writes", () => {
		expect(classifyCorpusCommand("cat input>output").features).toContain(
			"redirect",
		);
		expect(classifyCorpusCommand("git status 2>/dev/null").features).toContain(
			"redirect",
		);
		expect(classifyCorpusCommand("printf 'a>b'").features).not.toContain(
			"redirect",
		);
	});

	it("changes the corpus digest when routing metadata changes", () => {
		const base = extractBashCorpusJsonl(
			jsonl({ type: "session", id: "s" }, assistantCall("one", "git status")),
		).calls[0];
		const policy = {
			id: "p",
			evaluate: () => ({ route: "direct" as const, reason: "x" }),
		};
		const first = replayShadowPolicies([base], [policy]);
		const second = replayShadowPolicies([{ ...base, mode: "plan" }], [policy]);
		expect(first.corpusDigest).not.toBe(second.corpusDigest);
	});
});

function assistantCall(
	id: string,
	command: string,
	timestamp = "2025-01-01T01:00:00.000Z",
) {
	return {
		type: "message",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		},
	};
}

function toolResult(id: string, isError: boolean, exitCode: number) {
	return {
		type: "message",
		timestamp: "2025-01-01T01:01:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			isError,
			details: { exitCode },
			content: [],
		},
	};
}

function jsonl(...entries: readonly unknown[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

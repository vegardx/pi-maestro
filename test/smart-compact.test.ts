import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileOperations } from "@earendil-works/pi-coding-agent";
import {
	isMaestroOwnedCompaction,
	MAESTRO_COMPACTION_MARKER,
} from "@vegardx/pi-contracts";
import { redactSecrets } from "@vegardx/pi-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assembleSummary,
	buildFileSections,
	buildPrompt,
	escapeClosingTag,
} from "../packages/smart-compact/src/index.js";
import { readSmartCompactSettings } from "../packages/smart-compact/src/settings.js";

function fileOps(parts: Partial<FileOperations>): FileOperations {
	return {
		read: parts.read ?? new Set(),
		written: parts.written ?? new Set(),
		edited: parts.edited ?? new Set(),
	};
}

describe("smart-compact prompt construction", () => {
	it("escapes closing tags case-insensitively", () => {
		expect(
			escapeClosingTag("a </previous-summary> b", "previous-summary"),
		).toBe("a <\\/previous-summary> b");
		expect(escapeClosingTag("x </CONVERSATION> y", "conversation")).toBe(
			"x <\\/conversation> y",
		);
	});

	it("is deterministic for a fixed nonce and embeds the conversation", () => {
		const ops = fileOps({});
		const a = buildPrompt("HELLO", ops, undefined, undefined, "fixed-nonce");
		const b = buildPrompt("HELLO", ops, undefined, undefined, "fixed-nonce");
		expect(a).toBe(b);
		expect(a).toContain("<conversation-fixed-nonce>");
		expect(a).toContain("HELLO");
	});

	it("includes a frozen-prefix instruction only when a previous summary exists", () => {
		const ops = fileOps({});
		const withPrev = buildPrompt("c", ops, "PRIOR", undefined, "n");
		expect(withPrev).toContain("<previous-summary>");
		expect(withPrev).toContain("PRIOR");
		expect(withPrev).toMatch(/Do NOT restate, rewrite, merge, or summarise it/);
		const withoutPrev = buildPrompt("c", ops, undefined, undefined, "n");
		expect(withoutPrev).not.toContain("<previous-summary>");
		expect(withoutPrev).not.toMatch(/FROZEN/);
	});

	it("neutralises tag breakout in previous summary and custom instructions", () => {
		const ops = fileOps({});
		const prompt = buildPrompt(
			"c",
			ops,
			"break </previous-summary> out",
			"break </custom-instructions> out",
			"n",
		);
		expect(prompt).toContain("break <\\/previous-summary> out");
		expect(prompt).toContain("break <\\/custom-instructions> out");
	});
});

describe("smart-compact file sections", () => {
	it("sorts, dedupes written+edited, and renders both sections", () => {
		const ops = fileOps({
			read: new Set(["b.ts", "a.ts"]),
			written: new Set(["z.ts"]),
			edited: new Set(["z.ts", "m.ts"]),
		});
		const out = buildFileSections(ops, 50);
		expect(out).toContain("<read-files>\na.ts\nb.ts\n</read-files>");
		expect(out).toContain("<modified-files>\nm.ts\nz.ts\n</modified-files>");
	});

	it("caps long lists and reports the omitted count", () => {
		const read = new Set(Array.from({ length: 5 }, (_, i) => `f${i}.ts`));
		const out = buildFileSections(fileOps({ read }), 2);
		expect(out).toContain("(3 more not shown)");
	});

	it("renders nothing when there are no file ops", () => {
		expect(buildFileSections(fileOps({}), 50)).toBe("");
	});
});

describe("smart-compact append-only assembly", () => {
	it("returns the new section verbatim when no previous summary", () => {
		expect(assembleSummary("NEW")).toBe("NEW");
	});

	it("keeps the previous summary as an exact byte-for-byte prefix", () => {
		const prev =
			"## Current Focus\nold work\n<read-files>\nx.ts\n</read-files>";
		const result = assembleSummary("NEW SECTION", prev);
		expect(result.startsWith(prev)).toBe(true);
		expect(result.endsWith("NEW SECTION")).toBe(true);
	});

	it("chains slices append-only: each prior summary prefixes the next", () => {
		const s1 = assembleSummary("section-1");
		const s2 = assembleSummary("section-2", s1);
		const s3 = assembleSummary("section-3", s2);
		expect(s2.startsWith(s1)).toBe(true);
		expect(s3.startsWith(s2)).toBe(true);
	});
});

describe("smart-compact marker protocol", () => {
	it("recognises modes-owned compactions and ignores others", () => {
		expect(isMaestroOwnedCompaction(`${MAESTRO_COMPACTION_MARKER} abc`)).toBe(
			true,
		);
		expect(isMaestroOwnedCompaction("focus on the parser")).toBe(false);
		expect(isMaestroOwnedCompaction(undefined)).toBe(false);
	});
});

describe("redactSecrets", () => {
	it("redacts key=value secrets and bearer tokens", () => {
		expect(redactSecrets("api_key=sk-LIVE-deadbeef")).toBe(
			"api_key=[redacted]",
		);
		expect(redactSecrets("password: hunter2hunter2")).toBe(
			"password=[redacted]",
		);
		expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toContain(
			"Bearer [redacted]",
		);
	});

	it("redacts long opaque tokens but preserves paths and identifiers", () => {
		expect(redactSecrets("token is ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe(
			"token is [redacted]",
		);
		const safe =
			"packages/smart-compact/src/index.ts buildPrompt readSmartCompactSettings";
		expect(redactSecrets(safe)).toBe(safe);
	});

	it("is idempotent and passes undefined through", () => {
		const once = redactSecrets("api_key=sk-LIVE-deadbeefdeadbeef");
		expect(redactSecrets(once)).toBe(once);
		expect(redactSecrets(undefined)).toBeUndefined();
	});
});

describe("smart-compact settings", () => {
	let dir: string;
	let cwd: string;
	let agentDir: string;

	const writeSettings = (path: string, obj: unknown) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(obj, null, 2));
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "maestro-smart-compact-"));
		cwd = join(dir, "project");
		agentDir = join(dir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns defaults when unset, with compactAt undefined", () => {
		const s = readSmartCompactSettings(cwd, agentDir);
		expect(s.maxSummaryTokens).toBe(8192);
		expect(s.maxFileListEntries).toBe(50);
		expect(s.timeoutMs).toBe(60000);
		expect(s.compactAt).toBeUndefined();
	});

	it("reads overrides and treats non-positive compactAt as unset", () => {
		writeSettings(join(cwd, ".pi", "settings.json"), {
			extensionConfig: {
				"smart-compact": {
					maxSummaryTokens: 4096,
					maxFileListEntries: 10,
					timeoutMs: 30000,
					compactAt: 120000,
				},
			},
		});
		const s = readSmartCompactSettings(cwd, agentDir);
		expect(s.maxSummaryTokens).toBe(4096);
		expect(s.maxFileListEntries).toBe(10);
		expect(s.timeoutMs).toBe(30000);
		expect(s.compactAt).toBe(120000);

		writeSettings(join(cwd, ".pi", "settings.json"), {
			extensionConfig: { "smart-compact": { compactAt: 0 } },
		});
		expect(readSmartCompactSettings(cwd, agentDir).compactAt).toBeUndefined();
	});

	it("falls back to defaults on wrong-typed values", () => {
		writeSettings(join(cwd, ".pi", "settings.json"), {
			extensionConfig: {
				"smart-compact": { maxSummaryTokens: "lots", timeoutMs: null },
			},
		});
		const s = readSmartCompactSettings(cwd, agentDir);
		expect(s.maxSummaryTokens).toBe(8192);
		expect(s.timeoutMs).toBe(60000);
	});
});

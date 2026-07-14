import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildKnowledgeSession,
	KNOWLEDGE_CUSTOM_TYPE,
	KNOWLEDGE_END,
	KNOWLEDGE_FRAME,
	KNOWLEDGE_SECTIONS,
	KNOWLEDGE_SESSION_VERSION,
	KNOWLEDGE_TEMPLATE,
	readKnowledgeSession,
	validateKnowledgeDoc,
} from "../packages/modes/src/exec/knowledge.js";

const VALID_DOC = [
	KNOWLEDGE_FRAME,
	"",
	"## Project Structure",
	"packages/modes holds the plan engine; packages/rpc the socket transport.",
	"",
	"## Key Patterns",
	"Pure state machines with injected deps; adapters own the side effects.",
	"",
	"## Conventions",
	"Tabs, biome, sparse comments.",
	"",
	"## Key Interfaces",
	"Plan/Deliverable/AgentSpec in schema.ts; DeliverableExecutor drives execution.",
].join("\n");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maestro-knowledge-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("KNOWLEDGE_TEMPLATE", () => {
	it("carries the framing header and all required section headings", () => {
		expect(KNOWLEDGE_TEMPLATE).toContain("# Codebase Reference");
		expect(KNOWLEDGE_TEMPLATE).toContain("> CONTEXT ONLY");
		for (const section of KNOWLEDGE_SECTIONS) {
			expect(KNOWLEDGE_TEMPLATE).toContain(`## ${section}`);
		}
	});

	it("is a skeleton — fails validation until sections are filled", () => {
		const problems = validateKnowledgeDoc(KNOWLEDGE_TEMPLATE);
		expect(problems).toHaveLength(KNOWLEDGE_SECTIONS.length);
		for (const problem of problems) {
			expect(problem).toMatch(/is empty/);
		}
	});
});

describe("validateKnowledgeDoc", () => {
	it("accepts a filled doc", () => {
		expect(validateKnowledgeDoc(VALID_DOC)).toEqual([]);
	});

	it("flags a missing header and frame", () => {
		const problems = validateKnowledgeDoc("just some text");
		expect(problems).toContainEqual(
			expect.stringContaining("# Codebase Reference"),
		);
		expect(problems).toContainEqual(expect.stringContaining("CONTEXT ONLY"));
	});

	it("flags each missing section", () => {
		const doc = VALID_DOC.replace("## Key Patterns", "## Renamed");
		expect(validateKnowledgeDoc(doc)).toContainEqual(
			expect.stringContaining('missing section "## Key Patterns"'),
		);
	});

	it("flags an empty section", () => {
		const doc = VALID_DOC.replace("Tabs, biome, sparse comments.", "");
		expect(validateKnowledgeDoc(doc)).toContainEqual(
			expect.stringContaining('section "## Conventions" is empty'),
		);
	});
});

describe("buildKnowledgeSession", () => {
	it("writes header + custom_message JSONL in the session-file shape", () => {
		const outPath = join(dir, "base-knowledge.jsonl");
		const built = buildKnowledgeSession({
			content: VALID_DOC,
			repoPath: "/repo/path",
			outPath,
		});

		const lines = readFileSync(outPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);

		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.version).toBe(KNOWLEDGE_SESSION_VERSION);
		expect(header.id).toBe(built.id);
		expect(header.id).toMatch(/^base-/);
		expect(header.cwd).toBe("/repo/path");

		const entry = JSON.parse(lines[1]);
		expect(entry.type).toBe("custom_message");
		expect(entry.customType).toBe(KNOWLEDGE_CUSTOM_TYPE);
		expect(entry.content).toBe(`${VALID_DOC.trimEnd()}\n\n${KNOWLEDGE_END}\n`);
		expect(entry.display).toBe(true);
		expect(entry.parentId).toBeNull();
		expect(entry.id).toBe(built.entryId);
	});

	it("honours an explicit session id", () => {
		const outPath = join(dir, "base-knowledge.jsonl");
		const built = buildKnowledgeSession({
			content: VALID_DOC,
			repoPath: "/repo/path",
			outPath,
			id: "base-fixed",
		});
		expect(built.id).toBe("base-fixed");
	});

	it("appends the research index between the authored doc and the END marker", () => {
		const index =
			"## Research Index\n\n- [ref: auth-flow] How auth works (codebase)";
		const built = buildKnowledgeSession({
			content: VALID_DOC,
			repoPath: "/repo/path",
			outPath: join(dir, "base-knowledge.jsonl"),
			researchIndex: index,
		});
		expect(built.content).toContain("[ref: auth-flow]");
		expect(built.content.indexOf(index)).toBeGreaterThan(
			built.content.indexOf("## Key Interfaces"),
		);
		expect(built.content.indexOf(index)).toBeLessThan(
			built.content.indexOf(KNOWLEDGE_END),
		);
		// The result still round-trips the frozen-base validation.
		expect(readKnowledgeSession(built.path).content).toBe(built.content);
	});

	it("places the index before END even when the author already closed with it", () => {
		const authored = `${VALID_DOC}\n\n${KNOWLEDGE_END}\n`;
		const built = buildKnowledgeSession({
			content: authored,
			repoPath: "/repo/path",
			outPath: join(dir, "base-knowledge.jsonl"),
			researchIndex: "## Research Index\n\n- [ref: x] q (web)",
		});
		expect(built.content.indexOf("[ref: x]")).toBeLessThan(
			built.content.indexOf(KNOWLEDGE_END),
		);
		// Exactly one END marker survives.
		expect(built.content.split(KNOWLEDGE_END)).toHaveLength(2);
	});

	it("refuses to write a doc that fails shape validation", () => {
		const outPath = join(dir, "base-knowledge.jsonl");
		expect(() =>
			buildKnowledgeSession({
				content: "not a knowledge doc",
				repoPath: "/repo/path",
				outPath,
			}),
		).toThrow(/shape validation/);
	});
});

describe("readKnowledgeSession", () => {
	it("round-trips what buildKnowledgeSession wrote", () => {
		const outPath = join(dir, "base-knowledge.jsonl");
		const built = buildKnowledgeSession({
			content: VALID_DOC,
			repoPath: "/repo/path",
			outPath,
		});

		const read = readKnowledgeSession(outPath);
		expect(read.id).toBe(built.id);
		expect(read.cwd).toBe("/repo/path");
		expect(read.content).toBe(`${VALID_DOC.trimEnd()}\n\n${KNOWLEDGE_END}\n`);
		expect(read.entryId).toBe(built.entryId);
	});

	it("rejects a wrong session version", () => {
		const outPath = join(dir, "bad-version.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 2,
			id: "base-x",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
		});
		writeFileSync(outPath, `${header}\n`);
		expect(() => readKnowledgeSession(outPath)).toThrow(/version/);
	});

	it("rejects a session without the base-knowledge entry", () => {
		const outPath = join(dir, "no-entry.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: KNOWLEDGE_SESSION_VERSION,
			id: "base-x",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
		});
		writeFileSync(outPath, `${header}\n`);
		expect(() => readKnowledgeSession(outPath)).toThrow(
			new RegExp(KNOWLEDGE_CUSTOM_TYPE.replace(".", "\\.")),
		);
	});

	it("rejects a tampered doc that no longer passes shape validation", () => {
		const outPath = join(dir, "tampered.jsonl");
		buildKnowledgeSession({
			content: VALID_DOC,
			repoPath: "/repo/path",
			outPath,
		});
		const tampered = readFileSync(outPath, "utf8").replace(
			"## Key Interfaces",
			"## Gone",
		);
		writeFileSync(outPath, tampered);
		expect(() => readKnowledgeSession(outPath)).toThrow(/Key Interfaces/);
	});
});

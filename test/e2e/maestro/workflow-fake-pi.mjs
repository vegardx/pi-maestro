#!/usr/bin/env node

import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const prompt =
	process.argv.find(
		(argument) =>
			argument.includes("E2E_STAGE=") ||
			argument.includes("SANITIZED_FINDINGS_JSON="),
	) ?? "";
const stage =
	prompt.match(/E2E_STAGE=([a-z0-9-]+)/)?.[1] ??
	(prompt.includes("SANITIZED_FINDINGS_JSON=") ? "decision" : undefined);
if (!stage) {
	process.stderr.write("workflow e2e fake Pi received no E2E_STAGE marker\n");
	process.exit(3);
}

const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : "default/fake";
await appendFile(
	process.env.WORKFLOW_E2E_TRACE,
	`${JSON.stringify({
		stage,
		model,
		startedAt: Date.now(),
		failDecisionOnce: process.env.WORKFLOW_E2E_FAIL_DECISION_ONCE,
		argv: process.argv.slice(2),
		prompt,
	})}\n`,
);

if (stage.startsWith("review-")) {
	const barrier = process.env.WORKFLOW_E2E_REVIEW_BARRIER;
	if (!barrier) throw new Error("review worker received no cohort barrier");
	await mkdir(barrier, { recursive: true });
	await writeFile(join(barrier, `${stage}.ready`), "ready\n");
	const deadline = Date.now() + 10_000;
	while (
		(await readdir(barrier)).filter((name) => name.endsWith(".ready")).length <
		5
	) {
		if (Date.now() >= deadline)
			throw new Error(
				"review cohort did not launch all five workers in parallel",
			);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

if (stage === "decision" && process.env.WORKFLOW_E2E_FAIL_DECISION_ONCE) {
	const marker = process.env.WORKFLOW_E2E_FAIL_DECISION_ONCE;
	try {
		if ((await readFile(marker, "utf8")).trim() !== "resume") throw new Error();
	} catch {
		process.stderr.write("intentional decision interruption\n");
		process.exit(1);
	}
}

if (stage === "decision") {
	const denied = JSON.parse(
		process.env.PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS ?? "[]",
	);
	if (denied.length === 0)
		throw new Error(
			"decision did not receive the private reviewer artifact deny-read paths",
		);
	for (const path of denied) {
		let deniedBySandbox = false;
		try {
			await readFile(path, "utf8");
		} catch (error) {
			deniedBySandbox = error?.code === "EACCES" || error?.code === "EPERM";
		}
		if (!deniedBySandbox)
			throw new Error(`decision could read private reviewer artifact ${path}`);
	}
	await appendFile(
		process.env.WORKFLOW_E2E_TRACE,
		`${JSON.stringify({ stage: "decision-private-read-probe", denied: true, deniedCount: denied.length })}\n`,
	);
}

if (stage === "contracts-implement") {
	const path = join(process.env.WORKFLOW_E2E_CONTRACTS, "contract.json");
	await writeFile(
		path,
		`${JSON.stringify({ version: 2, endpoint: "/greet/{name}" }, null, 2)}\n`,
	);
}

if (stage === "api-implement") {
	const contract = JSON.parse(
		await readFile(
			join(process.env.WORKFLOW_E2E_CONTRACTS, "contract.json"),
			"utf8",
		),
	);
	if (contract.version !== 2) throw new Error("API ran before contract v2");
	const path = join(process.env.WORKFLOW_E2E_API, "src", "client.ts");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		"export const greetingUrl = (name: string) => `/greet/$" + "{name}`;\n",
	);
}

if (stage === "decision") {
	if (/review-security-(?:opus|fable|grok)/.test(prompt))
		throw new Error("reviewer identity leaked into the implementer prompt");
	const path = join(process.env.WORKFLOW_E2E_API, "src", "client.ts");
	await writeFile(
		path,
		"export const greetingUrl = (name: string) => `/greet/$" +
			"{encodeURIComponent(name)}`;\n",
	);
}

const controls = {
	"contracts-implement": { changed: ["contract.json"] },
	"api-implement": { changed: ["src/client.ts"] },
	"review-security-opus": {
		findings: [pathEncodingFinding("The path segment is interpolated raw.")],
	},
	"review-security-fable": {
		findings: [pathEncodingFinding("The name is not URL encoded.")],
	},
	"review-security-grok": {
		findings: [
			pathEncodingFinding("An unescaped name changes the path structure."),
			emptyNameFinding("The client accepts an empty name."),
		],
	},
	"review-correctness": {
		findings: [emptyNameFinding("No guard rejects the empty string.")],
	},
	"review-simplification": { findings: [] },
	decision: { decisions: decisionControls(prompt) },
};

const control = {
	schema: "stage-control-v1",
	digest: `workflow-e2e:${stage}`,
	...(controls[stage] ?? {}),
};
process.stdout.write(
	`${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: `<control>${JSON.stringify(control)}</control>\n<analysis>${stage} completed.</analysis>\n<refs>[]</refs>`,
				},
			],
			provider: model.split("/")[0],
			model: model.split("/").slice(1).join("/") || model,
			usage: {
				input: 100,
				output: 40,
				totalTokens: 140,
				cacheReadInputTokens: 20,
			},
			stopReason: "stop",
		},
	})}\n`,
);

function pathEncodingFinding(observation) {
	return {
		claim: "Greeting path parameters are not URL encoded.",
		evidence: [
			{ repository: "api", path: "src/client.ts", line: 1, observation },
		],
	};
}

function emptyNameFinding(observation) {
	return {
		claim: "Empty greeting names are accepted.",
		evidence: [
			{ repository: "api", path: "src/client.ts", line: 1, observation },
		],
	};
}

function decisionControls(compiledPrompt) {
	const serialized = compiledPrompt.match(
		/SANITIZED_FINDINGS_JSON=(\[[^\n]*\])/,
	)?.[1];
	if (!serialized) return [];
	const findings = JSON.parse(serialized);
	return findings.map((finding) =>
		finding.claim.includes("not URL encoded")
			? {
					findingId: finding.id,
					decision: "changed",
					reasoning: "A path segment must be encoded at the boundary.",
					changedPaths: [{ repository: "api", path: "src/client.ts" }],
				}
			: {
					findingId: finding.id,
					decision: "no_change",
					reasoning:
						"The contract intentionally permits an empty display name.",
				},
	);
}

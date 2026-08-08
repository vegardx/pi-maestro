#!/usr/bin/env node

import { appendFileSync, realpathSync } from "node:fs";

const prompt = process.argv.at(-1) ?? "";
if (!prompt.includes("SUPERVISOR_COMPOSITION_PROBE")) {
	process.stderr.write("fake pi received an unexpected prompt\n");
	process.exit(3);
}

appendFileSync(
	process.env.SUPERVISOR_COMPOSITION_LOG,
	`${JSON.stringify({
		argv: process.argv.slice(2),
		cwd: process.cwd(),
		home: process.env.HOME,
		replacementMarker: process.env.SUPERVISOR_REPLACEMENT_MARKER,
		hostSecretPresent: process.env.SUPERVISOR_HOST_ONLY_SECRET !== undefined,
		workflowState: realpathSync(`${process.cwd()}/.pi`),
	})}\n`,
);

const text = [
	'<control>{"schema":"stage-control-v1","digest":"composition-probe","value":"ok"}</control>',
	"<analysis>The fake Pi process completed the one flat workflow task.</analysis>",
	"<refs>[]</refs>",
].join("\n");

process.stdout.write(
	`${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "probe",
			model: "fake-pi",
			usage: {
				input: 10,
				output: 5,
				totalTokens: 15,
			},
			stopReason: "stop",
		},
	})}\n`,
);

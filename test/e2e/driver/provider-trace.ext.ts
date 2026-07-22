// Diagnostic-only extension: trace every outbound provider request and the
// response status that (does or does not) come back, to pin down where a
// mid-structuring stream hang happens. Loaded into the SUT via -e ONLY when
// PI_TRACE_LOG is set (the drive gates injection on it). Writes JSONL to
// PI_TRACE_LOG. NOT part of the maestro stack; never listed in package.json.

import { appendFileSync } from "node:fs";
import { defineExtension } from "@vegardx/pi-core";

const LOG = process.env.PI_TRACE_LOG || "/tmp/pi-provider-trace.jsonl";
let seq = 0;

function write(entry: Record<string, unknown>): void {
	try {
		appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
	} catch {
		// best-effort diagnostics; never disturb the run
	}
}

export default defineExtension(
	{
		name: "provider-trace",
		path: "test/e2e/driver/provider-trace.ext.ts",
		doc: "Trace outbound provider requests + response statuses (hang diagnosis).",
	},
	(pi) => {
		pi.on("before_provider_request", (event) => {
			seq += 1;
			const payload = (event as { payload?: unknown }).payload as
				| Record<string, unknown>
				| undefined;
			let size = -1;
			try {
				size = JSON.stringify(payload ?? {}).length;
			} catch {
				// circular / non-serializable — leave size as -1
			}
			// anthropic-messages: `messages` + `tools`; openai-responses: `input` + `tools`.
			const msgs =
				(payload?.messages as unknown[] | undefined) ??
				(payload?.input as unknown[] | undefined);
			const tools = payload?.tools as
				| Array<{ name?: string; function?: { name?: string } }>
				| undefined;
			write({
				ev: "request",
				seq,
				model: payload?.model,
				messages: Array.isArray(msgs) ? msgs.length : undefined,
				tools: Array.isArray(tools) ? tools.length : undefined,
				toolNames: Array.isArray(tools)
					? tools.map((t) => t?.name ?? t?.function?.name)
					: undefined,
				bodyBytes: size,
			});
		});
		pi.on("before_provider_headers", (event) => {
			const h = (event as { headers?: Record<string, unknown> }).headers ?? {};
			write({ ev: "headers", seq, url: h.url ?? h.URL ?? undefined });
		});
		pi.on("after_provider_response", (event) => {
			const status = (event as { status?: number }).status;
			write({ ev: "response", seq, status });
		});
	},
);

// Env-gated UI event tracer for diagnosing render loops (widget flicker).
//
// Set MAESTRO_UI_TRACE=1 (file lands in the OS tmpdir) or
// MAESTRO_UI_TRACE=/path/to/file and every overlay/widget lifecycle event is
// appended with a millisecond timestamp. Reading the file during a flicker
// names the oscillator: a healthy session shows sparse mounts/unmounts; a bug
// shows the same key cycling many times per second.

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let resolved: string | null | undefined;

function traceFile(): string | null {
	if (resolved !== undefined) return resolved;
	const env = process.env.MAESTRO_UI_TRACE;
	if (!env) {
		resolved = null;
	} else if (env === "1" || env.toLowerCase() === "true") {
		resolved = join(tmpdir(), "maestro-ui-trace.log");
	} else {
		resolved = env;
	}
	return resolved;
}

/** Append a timestamped UI event when MAESTRO_UI_TRACE is set. No-op otherwise. */
export function uiTrace(event: string, detail = ""): void {
	const file = traceFile();
	if (!file) return;
	try {
		const stamp = new Date().toISOString();
		appendFileSync(file, `${stamp} ${event}${detail ? ` ${detail}` : ""}\n`);
	} catch {
		// Tracing must never break the UI.
	}
}

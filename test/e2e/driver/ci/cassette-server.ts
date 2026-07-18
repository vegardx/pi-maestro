// A VCR-style cassette server for deterministic, offline model responses. The
// mock-provider extension points pi's provider baseUrl here; this server either
// records (proxies to the real upstream once, saving each request→response) or
// replays (serves the saved response for a matching request). Because it runs on
// a port and pi reads the base URL from config, it serves the maestro AND every
// headless worker in one place — cross-process determinism.
//
// Keying: sha256 of method + path + raw request body. Agentic runs seed workers
// deterministically (see the execution adapter's "deterministic framed seed"),
// so identical inputs reproduce identical request bodies → cassette hits. A
// prompt change invalidates affected entries; re-record with PI_E2E_RECORD=1.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

export type CassetteMode = "record" | "replay";

export interface CassetteServerOptions {
	/** Directory of cassette entries (`<key>.json`). Created if missing. */
	readonly dir: string;
	/** "replay" serves saved entries; "record" proxies upstream and saves. */
	readonly mode: CassetteMode;
	/** Upstream base URL for record mode (e.g. https://api.anthropic.com). */
	readonly upstreamBaseUrl?: string;
	/** Called on a replay miss (for logging/diagnostics). */
	readonly onMiss?: (key: string, method: string, path: string) => void;
}

interface CassetteEntry {
	readonly request: { method: string; path: string };
	readonly response: {
		status: number;
		headers: Record<string, string>;
		/** base64 of the raw response body, to preserve SSE bytes exactly. */
		bodyB64: string;
	};
}

export interface RunningCassetteServer {
	readonly url: string;
	readonly port: number;
	close(): Promise<void>;
}

export function keyFor(method: string, path: string, body: Buffer): string {
	return createHash("sha256")
		.update(method)
		.update("\n")
		.update(path)
		.update("\n")
		.update(body)
		.digest("hex")
		.slice(0, 40);
}

export function startCassetteServer(
	opts: CassetteServerOptions,
): Promise<RunningCassetteServer> {
	mkdirSync(opts.dir, { recursive: true });
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			void handle(
				opts,
				req.method ?? "GET",
				req.url ?? "/",
				Buffer.concat(chunks),
				res,
			);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				port,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

async function handle(
	opts: CassetteServerOptions,
	method: string,
	path: string,
	body: Buffer,
	res: import("node:http").ServerResponse,
): Promise<void> {
	const key = keyFor(method, path, body);
	const file = join(opts.dir, `${key}.json`);

	if (opts.mode === "replay") {
		if (!existsSync(file)) {
			opts.onMiss?.(key, method, path);
			res.writeHead(502, { "content-type": "text/plain" });
			res.end(
				`cassette miss: ${method} ${path} (key ${key}). Re-record with PI_E2E_RECORD=1.`,
			);
			return;
		}
		writeEntry(res, JSON.parse(readFileSync(file, "utf8")) as CassetteEntry);
		return;
	}

	// record: proxy upstream, save, return.
	if (!opts.upstreamBaseUrl) {
		res.writeHead(500, { "content-type": "text/plain" });
		res.end("record mode requires upstreamBaseUrl");
		return;
	}
	const upstream = await fetch(`${opts.upstreamBaseUrl}${path}`, {
		method,
		headers: forwardableHeaders(res),
		body:
			method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body),
	});
	const buf = Buffer.from(await upstream.arrayBuffer());
	const headers: Record<string, string> = {};
	upstream.headers.forEach((v, k) => {
		if (k !== "content-encoding" && k !== "content-length") headers[k] = v;
	});
	const entry: CassetteEntry = {
		request: { method, path },
		response: {
			status: upstream.status,
			headers,
			bodyB64: buf.toString("base64"),
		},
	};
	writeFileSync(file, JSON.stringify(entry, null, 2));
	writeEntry(res, entry);
}

function writeEntry(
	res: import("node:http").ServerResponse,
	entry: CassetteEntry,
): void {
	res.writeHead(entry.response.status, entry.response.headers);
	res.end(Buffer.from(entry.response.bodyB64, "base64"));
}

/** Record mode forwards the real auth header from the incoming request. */
function forwardableHeaders(
	_res: import("node:http").ServerResponse,
): Record<string, string> {
	// The pi client sends auth on the request; in record mode we run behind the
	// real credentials in the isolated home, so headers are already present on
	// the socket. Node's fetch needs them re-supplied — but for the Anthropic API
	// the SDK sets x-api-key/anthropic-version, which arrive on `req`. We rebuild
	// them from the environment to avoid leaking unrelated hop-by-hop headers.
	const out: Record<string, string> = { "content-type": "application/json" };
	if (process.env.ANTHROPIC_API_KEY)
		out["x-api-key"] = process.env.ANTHROPIC_API_KEY;
	out["anthropic-version"] = process.env.ANTHROPIC_VERSION ?? "2023-06-01";
	return out;
}

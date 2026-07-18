// Unit test for the cassette server: record against a fake upstream, then prove
// replay serves the identical bytes offline and misses fail loudly. This is the
// reusable determinism primitive for the CI full-stack driver.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCassetteServer } from "./cassette-server.js";

function fakeUpstream(body: string): Promise<{ url: string; server: Server }> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(body);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ url: `http://127.0.0.1:${port}`, server });
		});
	});
}

describe("cassette server", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cassette-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("records upstream then replays the identical response offline", async () => {
		const upstream = await fakeUpstream('event: hi\ndata: {"ok":true}\n\n');

		const rec = await startCassetteServer({
			dir,
			mode: "record",
			upstreamBaseUrl: upstream.url,
		});
		const recorded = await fetch(`${rec.url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ model: "x", messages: [] }),
		});
		expect(recorded.status).toBe(200);
		expect(await recorded.text()).toContain('data: {"ok":true}');
		await rec.close();
		upstream.server.close();

		// Replay with NO upstream available — must serve the saved bytes.
		const rep = await startCassetteServer({ dir, mode: "replay" });
		const replayed = await fetch(`${rep.url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ model: "x", messages: [] }),
		});
		expect(replayed.status).toBe(200);
		expect(replayed.headers.get("content-type")).toBe("text/event-stream");
		expect(await replayed.text()).toContain('data: {"ok":true}');
		await rep.close();
	});

	it("fails loudly on a replay miss", async () => {
		let missed = "";
		const rep = await startCassetteServer({
			dir,
			mode: "replay",
			onMiss: (key) => {
				missed = key;
			},
		});
		const res = await fetch(`${rep.url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ unseen: true }),
		});
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("cassette miss");
		expect(missed).toHaveLength(40);
		await rep.close();
	});
});

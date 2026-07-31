// The wire, over real sockets.
//
// The case that matters is "an agent waits to be let go". Everything else here
// is framing and handshake; that one is the reason the protocol was rebuilt at
// all. An agent that reported its result and then exited on its own schedule is
// what lost the output of all five nodes on one run, and no care at the
// collection site can close a window the protocol leaves open.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentLink,
	HandshakeRejected,
	MaestroLink,
} from "../packages/maestro/src/link.js";
import { PROTOCOL_VERSION } from "../packages/maestro/src/protocol.js";

const TOKEN = "run-token-1";

const dirs: string[] = [];
const links: { close(): unknown }[] = [];

afterEach(async () => {
	for (const link of links.splice(0)) await link.close();
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function maestro(token = TOKEN): Promise<[MaestroLink, string]> {
	const dir = mkdtempSync(join(tmpdir(), "maestro-link-"));
	dirs.push(dir);
	const link = new MaestroLink({ token });
	links.push(link);
	const path = join(dir, "m.sock");
	await link.listen(path);
	return [link, path];
}

function agent(): AgentLink {
	const link = new AgentLink();
	links.push(link);
	return link;
}

/** Let the event loop drain, so "did NOT happen" means something. */
const settle = () => new Promise((r) => setTimeout(r, 20));

function next<T>(
	link: MaestroLink,
	event: "connected" | "done" | "status" | "agentError" | "subagents",
): Promise<[string, T]> {
	return new Promise((resolve) => {
		link.once(event, (id: string, payload: unknown) =>
			resolve([id, payload as T]),
		);
	});
}

describe("the handshake", () => {
	it("welcomes an agent that presents the run token", async () => {
		const [link, path] = await maestro();
		const seen = next(link, "connected");
		await agent().connect(path, {
			agentId: "worker-1",
			token: TOKEN,
		});
		const [id, hello] = await seen;
		expect(id).toBe("worker-1");
		expect((hello as { v: number }).v).toBe(PROTOCOL_VERSION);
		expect(link.has("worker-1")).toBe(true);
	});

	it("rejects an agent belonging to another maestro", async () => {
		const [, path] = await maestro();
		await expect(
			agent().connect(path, {
				agentId: "worker-1",
				token: "some-other-run",
			}),
		).rejects.toThrow(HandshakeRejected);
	});

	it("rejects a version it does not speak, rather than guessing", async () => {
		const [link, path] = await maestro();
		// A maestro expecting a future protocol: the agent on this build speaks
		// PROTOCOL_VERSION and must be turned away, not half-understood.
		await link.close();
		const ahead = new MaestroLink({ token: TOKEN, version: 99 });
		links.push(ahead);
		await ahead.listen(path);
		await expect(
			agent().connect(path, {
				agentId: "worker-1",
				token: TOKEN,
			}),
		).rejects.toThrow(/version mismatch/);
	});

	it("leaves a rejected agent disconnected, not retrying", async () => {
		const [link, path] = await maestro();
		const a = agent();
		await expect(
			a.connect(path, { agentId: "w", token: "wrong" }),
		).rejects.toThrow(HandshakeRejected);
		await settle();
		expect(a.connected).toBe(false);
		expect(link.size).toBe(0);
	});

	it("TEARS DOWN the old connection when an agent reconnects", async () => {
		// This asserted `link.size === 1`, which a Map keyed on the agent id
		// guarantees whatever the code does — it passed with the replacement
		// removed entirely. What matters is that the first socket is actually
		// dropped: two live sockets under one id is how a maestro ends up
		// answering the wrong process, which a live drive did once.
		//
		// It also passed `resumed: true`, a flag written onto the wire and read
		// by nobody. That is gone.
		const [link, path] = await maestro();
		const first = agent();
		await first.connect(path, { agentId: "worker-1", token: TOKEN });
		const second = agent();
		await second.connect(path, { agentId: "worker-1", token: TOKEN });
		await settle();
		expect(link.size).toBe(1);
		expect(first.connected).toBe(false);
		expect(second.connected).toBe(true);
	});
});

describe("what an agent says while it works", () => {
	it("carries status", async () => {
		const [link, path] = await maestro();
		const a = agent();
		await a.connect(path, {
			agentId: "worker-1",
			token: TOKEN,
		});

		const status = next<{ state: string; detail?: string }>(link, "status");
		a.status("working", "running the tests");
		expect((await status)[1]).toEqual({
			type: "status",
			state: "working",
			detail: "running the tests",
		});
	});
});

describe("a worker's held subagents ride the wire", () => {
	const REVIEWER = {
		id: "code-review-1",
		persona: "code-review",
		state: "answering" as const,
		asked: 1,
	};

	it("keeps the latest snapshot beside the connection, whole for whole", async () => {
		const [link, path] = await maestro();
		const a = agent();
		await a.connect(path, { agentId: "worker-api", token: TOKEN });

		const first = next<readonly { id: string }[]>(link, "subagents");
		a.subagents([REVIEWER]);
		const [id, held] = await first;
		expect(id).toBe("worker-api");
		expect(held).toEqual([REVIEWER]);
		expect(link.heldBy("worker-api")).toEqual([REVIEWER]);

		// The next snapshot REPLACES — full map, not a delta, so the maestro
		// never has to reconcile what it missed.
		const second = next(link, "subagents");
		a.subagents([]);
		await second;
		expect(link.heldBy("worker-api")).toEqual([]);
	});

	it("answers nothing for a worker that is gone — its readers died with it", async () => {
		const [link, path] = await maestro();
		const a = agent();
		await a.connect(path, { agentId: "worker-api", token: TOKEN });
		const seen = next(link, "subagents");
		a.subagents([REVIEWER]);
		await seen;

		// Release, kill and crash all end here: the socket closes, the map entry
		// goes, and the snapshot goes with it. A held reader is a child process
		// of its worker, so an empty answer is the truth, not a miss.
		a.close();
		await settle();
		expect(link.heldBy("worker-api")).toEqual([]);
	});

	it("answers nothing for a worker that never reported", async () => {
		const [link, path] = await maestro();
		await agent().connect(path, { agentId: "worker-api", token: TOKEN });
		expect(link.heldBy("worker-api")).toEqual([]);
	});
});

describe("maestro owns the exit", () => {
	it("does NOT let an agent leave until it is released", async () => {
		const [link, path] = await maestro();
		const a = agent();
		await a.connect(path, {
			agentId: "worker-1",
			token: TOKEN,
		});

		const reported = next<{ handoff?: string }>(link, "done");
		let returned = false;
		const waiting = a
			.done({ outcome: "succeeded", handoff: "endpoint at /v1/things" })
			.then(() => {
				returned = true;
			});

		// Maestro has the whole result...
		const [id, done] = await reported;
		expect(id).toBe("worker-1");
		expect(done.handoff).toBe("endpoint at /v1/things");
		expect(link.awaitingRelease()).toEqual(["worker-1"]);

		// ...and the agent is still sitting there, holding its process open.
		await settle();
		expect(returned).toBe(false);
		expect(a.connected).toBe(true);

		link.release("worker-1");
		await waiting;
		expect(returned).toBe(true);
	});

	it("distinguishes a crash after reporting from one during the work", async () => {
		const [link, path] = await maestro();

		const reporter = agent();
		await reporter.connect(path, {
			agentId: "reporter",
			token: TOKEN,
		});
		const reported = next(link, "done");
		void reporter.done({ outcome: "succeeded" });
		await reported;

		const worker = agent();
		await worker.connect(path, {
			agentId: "quiet",
			token: TOKEN,
		});

		const gone = new Map<string, boolean>();
		link.on("disconnected", (id, awaiting) => gone.set(id, awaiting));
		reporter.close();
		worker.close();
		await settle();

		// The first one's result is already collected; the second's deliverable
		// failed and nothing was ever said about it.
		expect(gone.get("reporter")).toBe(true);
		expect(gone.get("quiet")).toBe(false);
	});

	it("unblocks an agent whose maestro went away, rather than hanging", async () => {
		const [link, path] = await maestro();
		const a = agent();
		await a.connect(path, {
			agentId: "worker-1",
			token: TOKEN,
		});
		const reported = next(link, "done");
		const waiting = a.done({ outcome: "succeeded" });
		await reported;
		await link.close();
		// Nobody is coming to release it. Waiting forever is the worse failure.
		await expect(waiting).resolves.toBeUndefined();
	});

	it("takes no result from a failure that does not say what happened", async () => {
		const [link, path] = await maestro();
		const a = agent();
		await a.connect(path, {
			agentId: "worker-1",
			token: TOKEN,
		});

		let recorded = false;
		link.on("done", () => {
			recorded = true;
		});
		const complaint = next<string>(link, "agentError");
		const stopped = new Promise<string>((r) => a.once("shutdown", r));

		// Past the client's own guard, as a badly-behaved agent would.
		(a as unknown as { send(m: unknown): boolean }).send({
			type: "done",
			outcome: "failed",
		});

		expect((await complaint)[1]).toMatch(/no reason given/);
		expect(await stopped).toMatch(/no reason given/);
		await settle();
		// "(agent produced no summary)" in a PR body was this: a record that
		// something ended, with nothing about what happened.
		expect(recorded).toBe(false);
		expect(link.awaitingRelease()).toEqual([]);
	});

	it("refuses to report a failure with no reason in the first place", async () => {
		const [, path] = await maestro();
		const a = agent();
		await a.connect(path, {
			agentId: "worker-1",
			token: TOKEN,
		});
		await expect(a.done({ outcome: "failed" })).rejects.toThrow(
			/no reason given/,
		);
	});

	it("refuses to report at all when there is nobody to report to", async () => {
		const a = agent();
		await expect(a.done({ outcome: "succeeded" })).rejects.toThrow(
			/not connected/,
		);
	});
});

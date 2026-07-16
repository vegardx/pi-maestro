// Transport-failure tests for the tmux-bridged runner — the battery both
// dogfood post-mortems require before tmux may become the default transport:
// prompt-loss-proof startup, bounded RPC requests, child-death rejection,
// executable discovery, incremental output, identity preservation, lineage,
// and session GC ordered before metadata deletion.

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RunBusMessage,
	RunId,
	RunProcessMetadata,
} from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunBus, type RunBus } from "../packages/subagents/src/bus.js";
import { persistRunBus } from "../packages/subagents/src/persist.js";
import { pruneRuns } from "../packages/subagents/src/retention.js";
import { createSemaphore } from "../packages/subagents/src/semaphore.js";
import type { LaunchRequest } from "../packages/subagents/src/service.js";
import {
	createRunStore,
	type RunStore,
} from "../packages/subagents/src/store.js";
import {
	createTmuxAgentRunner,
	resolveChildArgv,
} from "../packages/subagents/src/tmux-runner.js";

const READY = '{"type":"bridge_ready"}';

describe("tmux transport hardening", () => {
	let root: string;
	let store: RunStore;
	let bus: RunBus;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-tmux-"));
		store = createRunStore(root);
		bus = createRunBus();
		persistRunBus(bus, store);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/**
	 * A scripted stand-in for the tmux binary + bridged child. `spawn` records
	 * the shell command; the "child" is driven by the test through the same
	 * files the real bridge uses (rpc-input.jsonl / rpc-output.jsonl).
	 */
	function fakeTmux(behavior: {
		/** Write the ready marker on spawn (the real bridge's printf). */
		ready?: boolean;
		/** Respond to each input request by type → response factory. */
		respond?: (req: {
			id: string;
			type: string;
			message?: string;
		}) => Record<string, unknown> | undefined;
		/** Simulate child death: has-session starts failing. */
		alive?: () => boolean;
	}) {
		const commands: string[] = [];
		let runDir = "";
		let watcher: ReturnType<typeof setInterval> | undefined;
		let consumed = 0;
		const spawnFake = async (
			_session: string,
			_cwd: string,
			command: string,
		) => {
			commands.push(command);
			// The command embeds the run dir paths; recover the output path.
			const m = command.match(/>> '([^']*rpc-output\.jsonl)'/);
			runDir = m ? m[1].replace(/\/rpc-output\.jsonl$/, "") : "";
			if (behavior.ready !== false) {
				appendFileSync(join(runDir, "rpc-output.jsonl"), `${READY}\n`);
			}
			// Simulated bridged pi: answer requests appended to the input file.
			if (behavior.respond) {
				watcher = setInterval(() => {
					let raw = "";
					try {
						raw = readFileSync(join(runDir, "rpc-input.jsonl"), "utf8");
					} catch {
						return;
					}
					const lines = raw.split("\n").filter(Boolean);
					for (const line of lines.slice(consumed)) {
						consumed += 1;
						const req = JSON.parse(line) as {
							id: string;
							type: string;
							message?: string;
						};
						const response = behavior.respond?.(req);
						if (response) {
							appendFileSync(
								join(runDir, "rpc-output.jsonl"),
								`${JSON.stringify(response)}\n`,
							);
						}
					}
				}, 10);
				watcher.unref?.();
			}
			return { session: _session };
		};
		const exec = async (args: string[]) => {
			if (args[0] === "has-session") {
				if (behavior.alive && !behavior.alive()) throw new Error("no session");
				return "";
			}
			if (args[0] === "display-message") throw new Error("no pane info"); // force has-session liveness path
			return "";
		};
		return {
			commands,
			stop: () => watcher && clearInterval(watcher),
			tmux: {
				spawn: spawnFake as never,
				capturePane: (async () => "") as never,
				exec: exec as never,
			},
		};
	}

	function launch(
		tmux: ReturnType<typeof fakeTmux>["tmux"],
		extra: Record<string, unknown> = {},
	) {
		const runner = createTmuxAgentRunner({
			semaphore: createSemaphore(2),
			runsRoot: root,
			tmux,
			startupTimeoutMs: 500,
			rpcTimeoutMs: 300,
			alivePollMs: 25,
			...extra,
		});
		const request: LaunchRequest = {
			runId: "run-1" as RunId,
			prompt: "review this",
			profile: { profile: "research" },
			invocation: {
				cwd: root,
				args: [],
				env: {},
				depth: 1,
			},
		};
		bus.publish({
			type: "spawn",
			run: {
				id: request.runId,
				prompt: request.prompt,
				profile: request.profile,
			},
		});
		return runner.launch(request, bus);
	}

	/** A compliant child: acks the prompt, settles, and answers salvage. */
	const wellBehaved = () =>
		fakeTmux({
			respond: (req) => {
				if (req.type === "prompt") {
					// Ack, then finish the turn.
					setTimeout(() => {
						appendFileSync(
							join(root, "run-1", "rpc-output.jsonl"),
							`${JSON.stringify({ type: "agent_end" })}\n${JSON.stringify({ type: "agent_settled" })}\n`,
						);
					}, 30);
					return { type: "response", id: req.id, success: true };
				}
				if (req.type === "get_last_assistant_text") {
					return {
						type: "response",
						id: req.id,
						success: true,
						data: { text: "the report" },
					};
				}
				return { type: "response", id: req.id, success: true };
			},
		});

	it("delivers a prompt appended before the bridge tail starts (no -n 0 loss)", async () => {
		// The ready marker gates start(), and the bridge tails from the file's
		// beginning — so however the startup interleaves, the prompt survives.
		const fake = wellBehaved();
		const result = await launch(fake.tmux).result();
		fake.stop();
		expect(result.status).toBe("succeeded");
		expect(result.summary).toBe("the report");
		expect(fake.commands[0]).toContain("tail -n +1 -F");
		expect(fake.commands[0]).toContain(READY);
		// The prompt reached the input file exactly once.
		const input = readFileSync(join(root, "run-1", "rpc-input.jsonl"), "utf8");
		expect(input.match(/"type":"prompt"/g)).toHaveLength(1);
	});

	it("a bridge that never becomes ready fails within the startup deadline", async () => {
		const fake = fakeTmux({ ready: false });
		const result = await launch(fake.tmux).result();
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("startup deadline exceeded");
	});

	it("a prompt that is never answered fails within the RPC deadline", async () => {
		const fake = fakeTmux({ respond: () => undefined }); // ready, but mute
		const result = await launch(fake.tmux).result();
		fake.stop();
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("deadline exceeded");
	});

	it("child death rejects pending requests and settles the run", async () => {
		let alive = true;
		const fake = fakeTmux({
			alive: () => alive,
			respond: (req) => {
				if (req.type === "prompt") {
					// Ack the prompt, then die before ever finishing the turn.
					setTimeout(() => {
						alive = false;
					}, 30);
					return { type: "response", id: req.id, success: true };
				}
				return undefined;
			},
		});
		const result = await launch(fake.tmux).result();
		fake.stop();
		expect(result.status).toBe("failed");
		expect(result.error).toContain("tmux child exited");
	});

	it("incremental output split across arbitrary chunk boundaries still parses", async () => {
		// Events are appended byte-by-byte-ish; the drain's remainder handling
		// must reassemble lines across reads.
		const fake = fakeTmux({
			respond: (req) => {
				if (req.type === "prompt") {
					const out = join(root, "run-1", "rpc-output.jsonl");
					const event = `${JSON.stringify({ type: "tool_execution_start", toolName: "grep" })}\n${JSON.stringify({ type: "agent_end" })}\n${JSON.stringify({ type: "agent_settled" })}\n`;
					// Two writes, split mid-JSON.
					setTimeout(() => appendFileSync(out, event.slice(0, 17)), 20);
					setTimeout(() => appendFileSync(out, event.slice(17)), 50);
					return { type: "response", id: req.id, success: true };
				}
				if (req.type === "get_last_assistant_text") {
					return { type: "response", id: req.id, success: true, data: "ok" };
				}
				return { type: "response", id: req.id, success: true };
			},
		});
		const events: string[] = [];
		bus.subscribe((m: RunBusMessage) => {
			if (m.type === "progress" && m.delta.text) events.push(m.delta.text);
		});
		const result = await launch(fake.tmux).result();
		fake.stop();
		expect(result.status).toBe("succeeded");
		expect(events).toContain("grep");
	});

	it("the transport publishes process facts only — caller identity survives", async () => {
		const metadatas: RunProcessMetadata[] = [];
		bus.subscribe((m: RunBusMessage) => {
			if (m.type === "metadata") metadatas.push(m.metadata);
		});
		const fake = wellBehaved();
		await launch(fake.tmux).result();
		fake.stop();
		const fromTransport = metadatas.find((m) => m.tmuxSession);
		expect(fromTransport).toBeDefined();
		expect(fromTransport?.role).toBeUndefined();
		expect(fromTransport?.displayName).toBeUndefined();
		// Merge semantics: a prior identity publish is preserved in the store.
		bus.publish({
			type: "metadata",
			runId: "run-1" as RunId,
			metadata: { transport: "tmux", role: "reviewer", displayName: "sec" },
		});
		bus.publish({
			type: "metadata",
			runId: "run-1" as RunId,
			metadata: fromTransport as RunProcessMetadata,
		});
		const record = store.readRecord("run-1" as RunId);
		expect(record?.metadata?.role).toBe("reviewer");
		expect(record?.metadata?.displayName).toBe("sec");
		expect(record?.metadata?.tmuxSession).toContain("maestro-run-run-1");
	});

	it("resolveChildArgv: runnable script → node; bundled → execPath; else pi from PATH", () => {
		expect(resolveChildArgv("/opt/pi/cli.js")).toEqual([
			"node",
			"/opt/pi/cli.js",
		]);
		expect(resolveChildArgv("/opt/pi/cli.mjs")).toEqual([
			"node",
			"/opt/pi/cli.mjs",
		]);
		// A TS dev entry is not node-runnable — fall through to pi on PATH.
		expect(resolveChildArgv(undefined)).toEqual(["pi"]);
	});

	it("retention kills the tmux session BEFORE deleting metadata, and keeps the record when the kill cannot be verified", () => {
		const now = Date.now();
		const mkRun = (id: string, session?: string) => {
			store.create({
				id: id as RunId,
				profile: { profile: "research" },
				status: "queued",
				createdAt: now - 100 * 24 * 60 * 60 * 1000,
				updatedAt: now - 100 * 24 * 60 * 60 * 1000,
			});
			store.setStatus(id as RunId, "running");
			store.setResult(id as RunId, { status: "succeeded" });
			if (session) {
				store.setMetadata(id as RunId, {
					transport: "tmux",
					tmuxSession: session,
				});
			}
		};
		mkRun("old-tmux", "maestro-run-old-tmux");
		mkRun("old-stuck", "maestro-run-old-stuck");
		mkRun("old-headless");

		const killed: string[] = [];
		const result = pruneRuns(
			store,
			{ maxRuns: 0, maxAgeDays: 1, eventLogCapBytes: 1024 },
			now,
			{
				killTmuxSession: (session) => {
					killed.push(session);
					return session !== "maestro-run-old-stuck"; // one refuses to die
				},
			},
		);
		expect(killed).toContain("maestro-run-old-tmux");
		expect(killed).toContain("maestro-run-old-stuck");
		expect(result.pruned).toContain("old-tmux");
		expect(result.pruned).toContain("old-headless");
		// The unverified session's record survives — its pointer is not lost.
		expect(result.retained).toEqual(["old-stuck"]);
		expect(store.readRecord("old-stuck" as RunId)).toBeDefined();
		expect(store.readRecord("old-tmux" as RunId)).toBeUndefined();
	});
});

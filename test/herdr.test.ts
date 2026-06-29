import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "@vegardx/pi-herdr";

// --- herdrExec tests ---

describe("herdrExec", () => {
	it("exports HerdrError with code field", () => {
		const err = new HerdrError("not_found", "pane does not exist");
		expect(err.code).toBe("not_found");
		expect(err.message).toContain("not_found");
		expect(err.message).toContain("pane does not exist");
		expect(err.name).toBe("HerdrError");
	});
});

// --- resolveSocketPath tests ---

describe("resolveSocketPath", () => {
	const origEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...origEnv };
	});

	it("returns HERDR_SOCKET_PATH when set", async () => {
		const { resolveSocketPath } = await import("@vegardx/pi-herdr");
		process.env.HERDR_SOCKET_PATH = "/tmp/test-herdr.sock";
		expect(resolveSocketPath()).toBe("/tmp/test-herdr.sock");
	});

	it("returns undefined when no socket exists and no env set", async () => {
		const { resolveSocketPath } = await import("@vegardx/pi-herdr");
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_SESSION;
		// Point to a non-existent config dir.
		process.env.XDG_CONFIG_HOME = "/tmp/nonexistent-herdr-config";
		expect(resolveSocketPath()).toBeUndefined();
	});
});

// --- isHerdrAvailable tests ---

describe("isHerdrAvailable", () => {
	const origEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...origEnv };
	});

	it("returns false when HERDR_ENV is not set", async () => {
		const { isHerdrAvailable } = await import("@vegardx/pi-herdr");
		delete process.env.HERDR_ENV;
		expect(isHerdrAvailable()).toBe(false);
	});

	it("returns false when HERDR_ENV=1 but socket missing", async () => {
		const { isHerdrAvailable } = await import("@vegardx/pi-herdr");
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = "/tmp/nonexistent-herdr-test.sock";
		expect(isHerdrAvailable()).toBe(false);
	});

	it("returns true when HERDR_ENV=1 and socket exists", async () => {
		const { isHerdrAvailable } = await import("@vegardx/pi-herdr");
		const tmpDir = mkdtempSync(join(tmpdir(), "herdr-detect-"));
		const sockPath = join(tmpDir, "herdr.sock");
		// Create a real socket file.
		const srv = createServer();
		await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
		try {
			process.env.HERDR_ENV = "1";
			process.env.HERDR_SOCKET_PATH = sockPath;
			expect(isHerdrAvailable()).toBe(true);
		} finally {
			srv.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// --- HerdrEventClient tests (mock socket) ---

describe("HerdrEventClient", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: Server;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "herdr-events-"));
		sockPath = join(tmpDir, "test.sock");
		server = createServer();
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
	});

	afterEach(() => {
		server.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("connects and receives events", async () => {
		const { HerdrEventClient } = await import("@vegardx/pi-herdr");

		// When a client connects, send an ack then an event.
		server.on("connection", (socket) => {
			socket.on("data", (data) => {
				const req = JSON.parse(data.toString().trim());
				// Send subscription ack.
				socket.write(
					`${JSON.stringify({ id: req.id, result: { type: "subscribed" } })}\n`,
				);
				// Send an agent status event.
				setTimeout(() => {
					socket.write(
						`${JSON.stringify({
							event: {
								type: "pane.agent_status_changed",
								pane_id: "pane_1",
								agent_status: "idle",
								previous_agent_status: "working",
							},
						})}\n`,
					);
				}, 20);
			});
		});

		const client = new HerdrEventClient({ socketPath: sockPath });
		const events: unknown[] = [];
		client.on((event) => events.push(event));
		client.subscribe([{ type: "pane.agent_status_changed" }]);

		// Wait for the event to arrive.
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "pane.agent_status_changed",
			pane_id: "pane_1",
			agent_status: "idle",
			previous_agent_status: "working",
		});

		client.close();
	});

	it("reconnects on socket close", async () => {
		const { HerdrEventClient } = await import("@vegardx/pi-herdr");

		let connectionCount = 0;
		server.on("connection", (socket) => {
			connectionCount++;
			socket.on("data", (data) => {
				const req = JSON.parse(data.toString().trim());
				socket.write(
					`${JSON.stringify({ id: req.id, result: { type: "subscribed" } })}\n`,
				);
				// Close the connection on first connect to trigger reconnect.
				if (connectionCount === 1) {
					setTimeout(() => socket.destroy(), 10);
				}
			});
		});

		const client = new HerdrEventClient({
			socketPath: sockPath,
			reconnectMs: 50,
		});
		client.on(() => {});
		client.subscribe([{ type: "pane.agent_status_changed" }]);

		// Wait for reconnection to happen.
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(connectionCount).toBeGreaterThanOrEqual(2);
		client.close();
	});

	it("stops reconnecting after close()", async () => {
		const { HerdrEventClient } = await import("@vegardx/pi-herdr");

		const client = new HerdrEventClient({
			socketPath: sockPath,
			reconnectMs: 30,
		});
		client.on(() => {});
		client.subscribe([{ type: "pane.agent_status_changed" }]);

		// Let it connect.
		await new Promise((resolve) => setTimeout(resolve, 50));
		client.close();

		// After close, server should not see new connections.
		let connectionsAfterClose = 0;
		server.on("connection", () => connectionsAfterClose++);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(connectionsAfterClose).toBe(0);
	});
});

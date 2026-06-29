import * as cp from "node:child_process";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

vi.mock("node:child_process");

const mockExecFile = cp.execFile as unknown as MockInstance;

import {
	capturePane,
	hasSession,
	isTmuxAvailable,
	kill,
	killPane,
	list,
	sendKeys,
	spawn,
	splitWindow,
	switchClient,
	TmuxError,
	tmuxExec,
} from "@vegardx/pi-tmux";

function simulateExecFile(
	stdout: string,
	stderr = "",
	code: number | null = null,
) {
	mockExecFile.mockImplementation(
		(
			_cmd: string,
			_args: string[],
			cb: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (code !== null) {
				const err = Object.assign(new Error("fail"), { code });
				cb(err, stdout, stderr);
			} else {
				cb(null, stdout, stderr);
			}
		},
	);
}

describe("@vegardx/pi-tmux", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("TmuxError", () => {
		it("has correct code, stderr, and name", () => {
			const err = new TmuxError(1, "session not found\n");
			expect(err.name).toBe("TmuxError");
			expect(err.code).toBe(1);
			expect(err.stderr).toBe("session not found\n");
			expect(err.message).toBe("tmux exited with code 1: session not found");
		});
	});

	describe("isTmuxAvailable", () => {
		const originalTmux = process.env.TMUX;

		afterEach(() => {
			if (originalTmux !== undefined) {
				process.env.TMUX = originalTmux;
			} else {
				delete process.env.TMUX;
			}
		});

		it("returns true when TMUX is set", () => {
			process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
			expect(isTmuxAvailable()).toBe(true);
		});

		it("returns false when TMUX is unset", () => {
			delete process.env.TMUX;
			expect(isTmuxAvailable()).toBe(false);
		});
	});

	describe("tmuxExec", () => {
		it("returns stdout on success", async () => {
			simulateExecFile("output\n");
			const result = await tmuxExec(["list-sessions"]);
			expect(result).toBe("output\n");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				["list-sessions"],
				expect.any(Function),
			);
		});

		it("throws TmuxError on non-zero exit", async () => {
			simulateExecFile("", "no server running", 1);
			await expect(tmuxExec(["list-sessions"])).rejects.toThrow(TmuxError);
			await expect(tmuxExec(["list-sessions"])).rejects.toMatchObject({
				code: 1,
				stderr: "no server running",
			});
		});
	});

	describe("spawn", () => {
		it("passes correct args to tmux", async () => {
			simulateExecFile("");
			await spawn("atlas", "/tmp/work", "pi --session foo.jsonl");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				[
					"new-session",
					"-d",
					"-s",
					"atlas",
					"-c",
					"/tmp/work",
					"pi --session foo.jsonl",
				],
				expect.any(Function),
			);
		});
	});

	describe("sendKeys", () => {
		it("passes literal flag and Enter", async () => {
			simulateExecFile("");
			await sendKeys("atlas", "hello world");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				["send-keys", "-t", "atlas", "-l", "hello world", "Enter"],
				expect.any(Function),
			);
		});
	});

	describe("kill", () => {
		it("passes kill-session args", async () => {
			simulateExecFile("");
			await kill("atlas");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				["kill-session", "-t", "atlas"],
				expect.any(Function),
			);
		});
	});

	describe("list", () => {
		it("parses session format correctly", async () => {
			simulateExecFile(
				"atlas:1719600000:attached\nbravo:1719599000:detached\n",
			);
			const sessions = await list();
			expect(sessions).toEqual([
				{ name: "atlas", lastActivity: 1719600000, attached: true },
				{ name: "bravo", lastActivity: 1719599000, attached: false },
			]);
		});

		it("returns empty array for empty output", async () => {
			simulateExecFile("");
			const sessions = await list();
			expect(sessions).toEqual([]);
		});
	});

	describe("hasSession", () => {
		it("returns true when session exists (exit 0)", async () => {
			simulateExecFile("");
			expect(await hasSession("atlas")).toBe(true);
		});

		it("returns false when session does not exist (exit 1)", async () => {
			simulateExecFile("", "session not found: atlas", 1);
			expect(await hasSession("atlas")).toBe(false);
		});
	});

	describe("capturePane", () => {
		it("passes correct args with line count", async () => {
			simulateExecFile("line1\nline2\n");
			const result = await capturePane("atlas", 100);
			expect(result).toBe("line1\nline2\n");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				["capture-pane", "-t", "atlas", "-p", "-S", "-100"],
				expect.any(Function),
			);
		});
	});

	describe("switchClient", () => {
		it("passes switch-client args", async () => {
			simulateExecFile("");
			await switchClient("bravo");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				["switch-client", "-t", "bravo"],
				expect.any(Function),
			);
		});
	});

	describe("splitWindow", () => {
		it("returns pane ID from stdout", async () => {
			simulateExecFile("%5\n");
			const paneId = await splitWindow({
				percent: 40,
				command: "env -u TMUX tmux attach-session -t atlas",
			});
			expect(paneId).toBe("%5");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				[
					"split-window",
					"-h",
					"-p",
					"40",
					"-P",
					"-F",
					"#{pane_id}",
					"env -u TMUX tmux attach-session -t atlas",
				],
				expect.any(Function),
			);
		});

		it("includes target when specified", async () => {
			simulateExecFile("%2\n");
			await splitWindow({ target: "%1", command: "echo hi" });
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				["split-window", "-h", "-t", "%1", "-P", "-F", "#{pane_id}", "echo hi"],
				expect.any(Function),
			);
		});

		it("omits -h when horizontal is false", async () => {
			simulateExecFile("%3\n");
			await splitWindow({ horizontal: false, command: "echo hi" });
			const args = mockExecFile.mock.calls[0][1] as string[];
			expect(args).not.toContain("-h");
		});
	});

	describe("killPane", () => {
		it("passes kill-pane args", async () => {
			simulateExecFile("");
			await killPane("%5");
			expect(mockExecFile).toHaveBeenCalledWith(
				"tmux",
				["kill-pane", "-t", "%5"],
				expect.any(Function),
			);
		});
	});
});

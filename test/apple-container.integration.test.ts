import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	APPLE_CONTAINER_RESEARCH_IMAGE,
	AppleContainerStrongBackend,
	SpawnAppleContainerRunner,
} from "../packages/modes/src/isolation/apple-container.js";
import { ResearchWorkspaceManager } from "../packages/modes/src/isolation/workspace.js";

const enabled = process.env.PI_MAESTRO_APPLE_CONTAINER_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;

suite("Apple container Strong host integration", () => {
	let root = "";
	let source = "";
	let strong: AppleContainerStrongBackend;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "apple-container-integration-"));
		source = join(root, "source");
		await mkdir(source);
		await writeFile(join(source, "input.txt"), "host-only");
		strong = new AppleContainerStrongBackend({
			runner: new SpawnAppleContainerRunner(),
			workspaces: new ResearchWorkspaceManager({
				baseDir: join(root, "epochs"),
				listFiles: async () => ["input.txt"],
			}),
			sourceRoot: async () => source,
		});
		const probe = await strong.probe();
		if (!probe.supported)
			throw new Error(
				`Opt-in Apple container integration was requested but unavailable: ${probe.detail}\nPrepare ${APPLE_CONTAINER_RESEARCH_IMAGE} as documented.`,
			);
	});

	afterAll(async () => {
		await strong?.destroy();
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("copies privately, isolates env/network, enforces limits, and retains phase state", async () => {
		const output: Buffer[] = [];
		const command = [
			"set -eu",
			'test "$MAESTRO_RESEARCH_ISOLATION" = strong',
			'test -z "$SSH_AUTH_SOCK"',
			'test -z "$PI_MAESTRO_SOCK"',
			'test "$(ulimit -n)" -le 1024',
			'test "$(nproc)" -le 2',
			"test -f input.txt",
			"printf generated > generated.txt",
			"if command -v curl >/dev/null; then ! curl --max-time 2 https://example.com; fi",
		].join("; ");
		await strong.operations(source).exec(command, source, {
			onData: (chunk) => output.push(chunk),
			env: {
				PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				SSH_AUTH_SOCK: "/host/agent",
				PI_MAESTRO_SOCK: "/host/maestro",
			},
			timeout: 20,
		});
		await strong
			.operations(source)
			.exec('test "$(cat generated.txt)" = generated', source, {
				onData: (chunk) => output.push(chunk),
				timeout: 10,
			});
		expect(await readFile(join(source, "input.txt"), "utf8")).toBe("host-only");
		await expect(
			readFile(join(source, "generated.txt"), "utf8"),
		).rejects.toThrow();
	});

	it("force-cleans the VM after cancellation and can reconcile a new phase", async () => {
		const controller = new AbortController();
		const running = strong.operations(source).exec("sleep 120", source, {
			onData: () => {},
			signal: controller.signal,
			timeout: 120,
		});
		setTimeout(() => controller.abort(), 500);
		await expect(running).rejects.toThrow();
		await strong.reset(source);
		await expect(
			strong.operations(source).exec("true", source, {
				onData: () => {},
				timeout: 10,
			}),
		).resolves.toEqual({ exitCode: 0 });
	});
});

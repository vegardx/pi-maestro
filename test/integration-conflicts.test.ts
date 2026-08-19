import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoStandaloneIntegrations,
	configuredStandaloneIntegrations,
} from "../packages/maestro/src/integration-conflicts.js";

describe("standalone integration conflicts", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-integration-conflicts-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("accepts pi-maestro without standalone integrations", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["/src/pi-maestro"] }),
		);
		expect(configuredStandaloneIntegrations(cwd, agentDir)).toEqual([]);
		expect(() => assertNoStandaloneIntegrations(cwd, agentDir)).not.toThrow();
	});

	it("finds versioned string and object package entries across settings", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["npm:@agwab/pi-workflow@0.12.0", "pi-web-access@0.18.0"],
			}),
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				packages: [{ source: "npm:@agwab/pi-subagent", skills: [] }],
			}),
		);

		expect(configuredStandaloneIntegrations(cwd, agentDir)).toEqual([
			"@agwab/pi-subagent",
			"@agwab/pi-workflow",
			"pi-web-access",
		]);
	});

	it("allows a standalone package whose extensions are disabled", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [{ source: "npm:@agwab/pi-workflow", extensions: [] }],
			}),
		);
		expect(configuredStandaloneIntegrations(cwd, agentDir)).toEqual([]);
	});

	it("fails with actionable removal guidance", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@agwab/pi-workflow"] }),
		);
		expect(() => assertNoStandaloneIntegrations(cwd, agentDir)).toThrow(
			/pi-maestro already bundles @agwab\/pi-workflow.*Remove the standalone entry.*keep pi-maestro.*restart Pi/,
		);
	});
});

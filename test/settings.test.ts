import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExtensionEnabled, isFlagEnabled } from "@vegardx/pi-core";
import {
	__resetSettingsLayer,
	createSettingsLayer,
	getConfigBoolean,
	getConfigNumber,
	getConfigStringArray,
	installSettingsLayer,
	readExtensionConfigKey,
	readLayeredExtensionConfig,
	writeExtensionConfigKey,
} from "@vegardx/pi-settings";

let dir: string;
let cwd: string;
let agentDir: string;

function writeSettings(path: string, obj: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(obj, null, 2));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maestro-settings-"));
	cwd = join(dir, "project");
	agentDir = join(dir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	__resetSettingsLayer();
});

afterEach(() => {
	__resetSettingsLayer();
	rmSync(dir, { recursive: true, force: true });
});

describe("layered reader", () => {
	it("merges project over global at the leaf, keeping sibling flags", () => {
		writeSettings(join(agentDir, "settings.json"), {
			extensionConfig: {
				modes: { enabled: true, flags: { fanout: false, sequential: true } },
			},
		});
		writeSettings(join(cwd, ".pi", "settings.json"), {
			extensionConfig: { modes: { flags: { fanout: true } } },
		});

		const { merged } = readLayeredExtensionConfig(cwd, agentDir);
		expect(merged.modes.enabled).toBe(true); // from global, untouched
		const flags = merged.modes.flags as Record<string, unknown>;
		expect(flags.fanout).toBe(true); // project wins
		expect(flags.sequential).toBe(true); // global sibling survives
	});

	it("typed accessors fail closed on missing or mistyped values", () => {
		const config = {
			demo: { count: 3, list: ["a", "b"], bad: "x", mixed: [1, "a"] },
		};
		expect(getConfigNumber(config, "demo", "count", 0)).toBe(3);
		expect(getConfigNumber(config, "demo", "bad", 7)).toBe(7);
		expect(getConfigBoolean(config, "demo", "missing", true)).toBe(true);
		expect(getConfigStringArray(config, "demo", "list", [])).toEqual([
			"a",
			"b",
		]);
		expect(getConfigStringArray(config, "demo", "mixed", ["d"])).toEqual(["d"]);
	});
});

describe("atomic writer", () => {
	it("writes and reads back a dotted key, preserving other keys", () => {
		writeSettings(join(cwd, ".pi", "settings.json"), {
			theme: "dark",
			extensionConfig: { other: { enabled: true } },
		});
		writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"flags.fanout",
			false,
			agentDir,
		);
		expect(
			readExtensionConfigKey("project", cwd, "modes", "flags.fanout", agentDir),
		).toBe(false);
		const raw = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(raw.theme).toBe("dark");
		expect(raw.extensionConfig.other.enabled).toBe(true);
	});

	it("deletes a key and prunes emptied containers", () => {
		writeExtensionConfigKey("project", cwd, "modes", "flags.x", true, agentDir);
		writeExtensionConfigKey("project", cwd, "modes", "flags.x", null, agentDir);
		const raw = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(raw.extensionConfig).toBeUndefined();
	});

	it("refuses prototype-polluting segments", () => {
		expect(() =>
			writeExtensionConfigKey(
				"project",
				cwd,
				"modes",
				"__proto__.polluted",
				true,
				agentDir,
			),
		).toThrow(/prototype-polluting/);
	});
});

describe("settings layer bridge to core", () => {
	it("createSettingsLayer reads enabled + nested flags", () => {
		const layer = createSettingsLayer({
			modes: { enabled: false, flags: { fanout: true } },
			ask: {},
		});
		expect(layer.extensionEnabled("modes")).toBe(false);
		expect(layer.extensionEnabled("ask")).toBeUndefined();
		expect(layer.flagEnabled("modes.fanout")).toBe(true);
		expect(layer.flagEnabled("modes.missing")).toBeUndefined();
	});

	it("installSettingsLayer makes core honour settings", () => {
		writeSettings(join(cwd, ".pi", "settings.json"), {
			extensionConfig: { demo: { enabled: false, flags: { thing: false } } },
		});
		// before install: default-on
		expect(isExtensionEnabled("demo")).toBe(true);
		installSettingsLayer({ cwd, agentDir });
		expect(isExtensionEnabled("demo")).toBe(false);
		expect(isFlagEnabled("demo", "thing")).toBe(false);
	});

	it("install is idempotent unless forced", () => {
		writeSettings(join(cwd, ".pi", "settings.json"), {
			extensionConfig: { demo: { enabled: false } },
		});
		installSettingsLayer({ cwd, agentDir });
		// change the file, but a non-forced install keeps the first snapshot
		writeSettings(join(cwd, ".pi", "settings.json"), {
			extensionConfig: { demo: { enabled: true } },
		});
		installSettingsLayer({ cwd, agentDir });
		expect(isExtensionEnabled("demo")).toBe(false);
		installSettingsLayer({ cwd, agentDir, force: true });
		expect(isExtensionEnabled("demo")).toBe(true);
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getTierModel,
	parseModelSpec,
	readBackgroundModels,
	resolveModel,
	writeBackgroundModel,
} from "@vegardx/pi-models";

let dir: string;
let cwd: string;
let agentDir: string;
let savedAgentDirEnv: string | undefined;

function writeSettings(path: string, obj: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(obj, null, 2));
}

function projectSettings(obj: unknown): void {
	writeSettings(join(cwd, ".pi", "settings.json"), obj);
}

// Fake registry: any spec maps to a model object; auth keyed by provider.
function fakeCtx(opts: {
	withApiKey?: Set<string>;
	noAuth?: Set<string>;
	sessionModel?: string;
}): ExtensionContext {
	return {
		cwd,
		model: opts.sessionModel
			? ({
					provider: opts.sessionModel.split("/")[0],
					id: opts.sessionModel,
				} as never)
			: undefined,
		modelRegistry: {
			find: (provider: string, modelId: string) => ({
				provider,
				id: modelId,
			}),
			getApiKeyAndHeaders: async (model: { provider: string }) => {
				if (opts.noAuth?.has(model.provider)) {
					return { ok: false, error: "no auth" };
				}
				if (opts.withApiKey?.has(model.provider)) {
					return { ok: true, apiKey: "sk-test" };
				}
				return { ok: true };
			},
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maestro-models-"));
	cwd = join(dir, "project");
	agentDir = join(dir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// Isolate the global settings layer from the developer's real ~/.pi so
	// resolveModel (which reads pi's default agent dir) sees only fixtures.
	savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
	rmSync(dir, { recursive: true, force: true });
});

describe("parseModelSpec", () => {
	it("splits provider/id and rejects malformed specs", () => {
		expect(parseModelSpec("anthropic/claude")).toEqual({
			provider: "anthropic",
			modelId: "claude",
		});
		expect(parseModelSpec("noslash")).toBeNull();
		expect(parseModelSpec("/leading")).toBeNull();
		expect(parseModelSpec("trailing/")).toBeNull();
	});
});

describe("tier resolution + fallback", () => {
	it("reads merged tiers and falls back secondary→primary", () => {
		writeSettings(join(agentDir, "settings.json"), {
			backgroundModels: { primary: { fast: "p/fast", heavy: "p/heavy" } },
		});
		projectSettings({
			backgroundModels: { secondary: { fast: "s/fast" } },
		});
		const models = readBackgroundModels(cwd, agentDir);
		expect(getTierModel(models, "fast", "secondary")).toBe("s/fast");
		// heavy not under secondary → primary fallback
		expect(getTierModel(models, "heavy", "secondary")).toBe("p/heavy");
		expect(getTierModel(models, "fast", "primary")).toBe("p/fast");
		expect(getTierModel(models, "normal", "primary")).toBeUndefined();
	});
});

describe("atomic background-model writes", () => {
	it("writes then prunes a tier, removing emptied containers", () => {
		writeBackgroundModel("project", cwd, "primary", "fast", "x/y", agentDir);
		expect(getTierModel(readBackgroundModels(cwd, agentDir), "fast")).toBe(
			"x/y",
		);
		writeBackgroundModel("project", cwd, "primary", "fast", null, agentDir);
		expect(readBackgroundModels(cwd, agentDir).primary).toEqual({});
	});
});

describe("resolveModel", () => {
	it("prefers explicit over config over tier", async () => {
		projectSettings({
			extensionConfig: { demo: { model: "cfg/model" } },
			backgroundModels: { primary: { normal: "tier/model" } },
		});
		const ctx = fakeCtx({ withApiKey: new Set(["explicit"]) });
		const r = await resolveModel(ctx, {
			name: "demo",
			tier: "normal",
			explicit: "explicit/model",
		});
		expect(r?.model.provider).toBe("explicit");
		expect(r?.apiKey).toBe("sk-test");
	});

	it("falls through unauthed candidates to the tier model", async () => {
		projectSettings({
			extensionConfig: { demo: { model: "cfg/model" } },
			backgroundModels: { primary: { normal: "tier/model" } },
		});
		// cfg provider has no auth; tier provider does
		const ctx = fakeCtx({
			noAuth: new Set(["cfg"]),
			withApiKey: new Set(["tier"]),
		});
		const r = await resolveModel(ctx, { name: "demo", tier: "normal" });
		expect(r?.model.provider).toBe("tier");
	});

	it("falls back to the session model when nothing configured", async () => {
		const ctx = fakeCtx({ sessionModel: "sess/model" });
		const r = await resolveModel(ctx, { name: "demo", tier: "fast" });
		expect(r?.model.id).toBe("sess/model");
	});

	it("returns null when nothing resolves", async () => {
		const ctx = fakeCtx({});
		expect(await resolveModel(ctx, { name: "demo", tier: "fast" })).toBeNull();
	});

	it("skips ok-but-keyless candidates when requireApiKey is set", async () => {
		projectSettings({
			backgroundModels: { primary: { fast: "keyless/model" } },
		});
		// keyless provider authenticates ok but yields no apiKey
		const ctx = fakeCtx({});
		const r = await resolveModel(ctx, {
			name: "demo",
			tier: "fast",
			requireApiKey: true,
		});
		expect(r).toBeNull();
	});
});

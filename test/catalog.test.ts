import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDelegateSelection } from "../packages/subagents/src/catalog.js";

let root = "";
afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function ctx(): ExtensionContext {
	root = mkdtempSync(join(tmpdir(), "delegate-catalog-"));
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "settings.json"),
		JSON.stringify({
			models: {
				profiles: {
					main: {
						targets: ["session/live"],
						roles: {
							delegate: {
								models: ["provider/default", "provider/alt"],
								efforts: ["low", "high"],
							},
						},
					},
				},
			},
		}),
	);
	const models = new Map(
		["session/live", "provider/default", "provider/alt"].map((id) => {
			const [provider, model] = id.split("/");
			return [
				id,
				{ provider, id: model, reasoning: true, contextWindow: 200000 },
			];
		}),
	);
	return {
		cwd: root,
		model: models.get("session/live"),
		modelRegistry: {
			find: (provider: string, id: string) => models.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
		},
	} as unknown as ExtensionContext;
}

describe("delegate catalog", () => {
	it("returns ordered policy metadata and validates exact choices", async () => {
		const context = ctx();
		const selected = await resolveDelegateSelection(context);
		expect(selected.model).toBe("provider/default");
		expect(
			selected.models.map((item) => [item.id, item.default, item.available]),
		).toEqual([
			["provider/default", true, true],
			["provider/alt", false, true],
		]);
		await expect(
			resolveDelegateSelection(context, { model: "outside/model" }),
		).rejects.toThrow("not in the delegate pool");
	});
});

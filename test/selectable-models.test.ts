// selectableModels: the picker's model source honors the registry's
// provider-filtered "available" snapshot (which drops per-account-disabled
// models like Copilot's non-enabled targets) and falls back to the raw catalog
// only when that snapshot is cold/absent — so the picker never lists a model
// the account can't actually use, yet never shows nothing.

import { describe, expect, it } from "vitest";
import { selectableModels } from "../packages/settings/src/menu-shared.js";

describe("selectableModels", () => {
	it("prefers the provider-filtered available snapshot over the raw catalog", () => {
		const registry = {
			// e.g. Copilot: sol is enabled for the account, terra is not.
			getAvailable: () => [{ provider: "github-copilot", id: "gpt-5.6-sol" }],
			getAll: () => [
				{ provider: "github-copilot", id: "gpt-5.6-sol" },
				{ provider: "github-copilot", id: "gpt-5.6-terra" },
			],
		};
		expect(selectableModels(registry).map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
		]);
	});

	it("falls back to the full catalog when the available snapshot is empty", () => {
		const registry = {
			getAvailable: () => [],
			getAll: () => [
				{ provider: "p", id: "a" },
				{ provider: "p", id: "b" },
			],
		};
		expect(selectableModels(registry).map((m) => m.id)).toEqual(["a", "b"]);
	});

	it("falls back to getAll when getAvailable is absent (older registry)", () => {
		const registry = { getAll: () => [{ provider: "p", id: "a" }] };
		expect(selectableModels(registry).map((m) => m.id)).toEqual(["a"]);
	});

	it("returns empty when the registry exposes neither", () => {
		expect(selectableModels({})).toEqual([]);
	});
});

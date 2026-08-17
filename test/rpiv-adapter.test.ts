import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setSettingsLayer } from "@vegardx/pi-core";
import { afterEach, describe, expect, it } from "vitest";
import rpivAskExtension from "../packages/ask/src/rpiv-extension.js";

function host() {
	const tools: string[] = [];
	const api = {
		events: { emit() {}, on: () => () => {} },
		on() {},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
	} as unknown as ExtensionAPI;
	return { api, tools };
}

afterEach(() => {
	delete process.env.PI_EXT_ASK_USER_QUESTION;
	setSettingsLayer(undefined);
});

describe("rpiv ask-user-question adapter", () => {
	it("loads the model-facing questionnaire through the package manifest", async () => {
		const { api, tools } = host();
		await rpivAskExtension(api);
		expect(tools).toContain("ask_user_question");
	});

	it("registers nothing when its extension kill switch is off", async () => {
		process.env.PI_EXT_ASK_USER_QUESTION = "off";
		const { api, tools } = host();
		await rpivAskExtension(api);
		expect(tools).toEqual([]);
	});
});

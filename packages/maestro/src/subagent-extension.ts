import { defineExtension } from "@vegardx/pi-core";
import { assertNoStandaloneIntegrations } from "./integration-conflicts.js";

export default defineExtension(
	{
		name: "subagent",
		path: "packages/maestro/src/subagent-extension.ts",
		doc: "Public pi-subagent extension bundled by pi-maestro.",
	},
	async (pi) => {
		assertNoStandaloneIntegrations(process.cwd());
		const packageName = "@agwab/pi-subagent";
		const extension = (await import(packageName)).default;
		await extension(pi);
	},
);

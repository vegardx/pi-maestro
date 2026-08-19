import { defineExtension } from "@vegardx/pi-core";
import { assertNoStandaloneIntegrations } from "./integration-conflicts.js";

export default defineExtension(
	{
		name: "workflow",
		path: "packages/maestro/src/workflow-extension.ts",
		doc: "Public pi-workflow extension bundled by pi-maestro.",
	},
	async (pi) => {
		assertNoStandaloneIntegrations(process.cwd());
		const packageName = "@agwab/pi-workflow/extension";
		const extension = (await import(packageName)).default;
		await extension(pi);
	},
);

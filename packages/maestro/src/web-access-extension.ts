import { defineExtension } from "@vegardx/pi-core";
import { assertNoStandaloneIntegrations } from "./integration-conflicts.js";

export default defineExtension(
	{
		name: "web-access",
		path: "packages/maestro/src/web-access-extension.ts",
		doc: "Public pi-web-access extension bundled by pi-maestro.",
	},
	async (pi) => {
		assertNoStandaloneIntegrations(process.cwd());
		const packageName = "pi-web-access";
		const extension = (await import(packageName)).default;
		await extension(pi);
	},
);

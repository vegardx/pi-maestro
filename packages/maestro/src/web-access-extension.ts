import { defineExtension } from "@vegardx/pi-core";

export default defineExtension(
	{
		name: "web-access",
		path: "packages/maestro/src/web-access-extension.ts",
		doc: "Public pi-web-access extension bundled by pi-maestro.",
	},
	async (pi) => {
		const packageName = "pi-web-access";
		const extension = (await import(packageName)).default;
		await extension(pi);
	},
);

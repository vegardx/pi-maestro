import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const LIBRARIES = [
	"contracts",
	"core",
	"settings",
	"models",
	"ui",
	"git",
	"github",
];
const EXTENSIONS = [
	"ask",
	"prompt-assist",
	"subagents",
	"commit",
	"smart-compact",
	"modes",
];

describe("scaffold", () => {
	it("ships every v1 package", () => {
		for (const name of [...LIBRARIES, ...EXTENSIONS]) {
			expect(existsSync(join(ROOT, "packages", name, "package.json"))).toBe(
				true,
			);
			expect(existsSync(join(ROOT, "packages", name, "src", "index.ts"))).toBe(
				true,
			);
		}
	});

	it("names every package @vegardx/pi-<dir>", () => {
		for (const name of [...LIBRARIES, ...EXTENSIONS]) {
			const sub = JSON.parse(
				readFileSync(join(ROOT, "packages", name, "package.json"), "utf8"),
			);
			expect(sub.name).toBe(`@vegardx/pi-${name}`);
		}
	});

	it("wires exactly the extension packages into the pi manifest", () => {
		const entries = [...pkg.pi.extensions].sort();
		const want = EXTENSIONS.map((n) => `packages/${n}/src/index.ts`).sort();
		expect(entries).toEqual(want);
	});

	it("uses the repo root as the bundle (@vegardx/pi)", () => {
		expect(pkg.name).toBe("@vegardx/pi");
		expect(pkg.keywords).toContain("pi-package");
	});
});

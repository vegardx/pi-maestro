// Phase 0 enumeration runner (key-free). Boots the REAL seeded sandbox-features
// drive against the logging stub instead of a cassette: every model call is
// logged (actor fingerprint, resolved model, tools) while the stub returns a
// trivial text turn so the drive progresses far enough to surface each actor.
//
// It does NOT complete a ship — the stub emits no tool calls, so workers do no
// work. The output is the model-call CATALOG the scripted mock (Phase 1) must
// answer. Run:  node_modules/.bin/jiti test/e2e/driver/ci/enumerate.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedAnswerer } from "../answerer.js";
import { readPlan } from "../assertions.js";
import { setupCiEnv } from "../env-profile.js";
import { launchSut } from "../launch.js";
import { seedScenarioPlan } from "../seed-plan.js";
import { startLoggingStub } from "./logging-stub.js";

const CI_DIR = join(process.cwd(), "test", "e2e", "driver", "ci");
const MAX_MS = 45_000;
const SETTLE = new Set(["shipped", "failed", "abandoned", "superseded"]);

async function main(): Promise<void> {
	const logDir = mkdtempSync(join(tmpdir(), "pi-e2e-enum-"));
	const logPath = join(logDir, "requests.jsonl");
	const bodyDir = join(logDir, "bodies");
	const stub = await startLoggingStub({ logPath, bodyDir });
	process.stdout.write(`logging stub at ${stub.url}\nlog: ${logPath}\n`);

	const profile = setupCiEnv({
		mockBaseUrl: stub.url,
		ghShimDir: join(CI_DIR, "gh-shim"),
		keep: true,
	});
	process.stdout.write(
		`piHome: ${profile.piHome}\nrepoDir: ${profile.repoDir}\n`,
	);
	// Seed the plan so the drive opens it and goes straight at execution — no
	// model-sensitive authoring in the enumeration.
	const slug = seedScenarioPlan(profile.piHome, profile.repoDir);

	const sut = launchSut({
		maestroRoot: process.cwd(),
		repoDir: profile.repoDir,
		piHome: profile.piHome,
		answerer: new ScriptedAnswerer(),
		env: profile.env,
		extraExtensions: profile.extraExtensions,
		transcriptPath: join(profile.piHome, "events.jsonl"),
	});

	const steps = [`/plan ${slug}`, "/start"];
	for (const prompt of steps) {
		const state = (await sut.client.getState()) as { isStreaming?: boolean };
		await sut.client.prompt(prompt, state.isStreaming ? "followUp" : undefined);
		await sleep(1500);
	}

	const start = Date.now();
	let lastCount = -1;
	while (Date.now() - start < MAX_MS) {
		await sleep(3000);
		const death = sut.died();
		if (death) {
			process.stdout.write(
				`SUT died: code=${death.code} signal=${death.signal}\n${death.stderr ?? ""}\n`,
			);
			break;
		}
		if (stub.records.length !== lastCount) {
			lastCount = stub.records.length;
			process.stdout.write(
				`... ${lastCount} model calls, ${Math.round((Date.now() - start) / 1000)}s\n`,
			);
		}
		const plan = readPlan(profile.piHome, slug);
		const nodes = plan?.nodes ?? [];
		if (nodes.length > 0 && nodes.every((n) => SETTLE.has(n.status))) {
			process.stdout.write("plan settled\n");
			break;
		}
	}

	// Summary: unique actors by (systemHead prefix + tools), with the model each
	// resolved to. This is the scripted-mock spec.
	const byActor = new Map<
		string,
		{ count: number; model: string; tools: string[]; head: string }
	>();
	for (const r of stub.records) {
		// Fingerprint on the tool signature + the ask — the persona is appended
		// after a shared generic prompt head, so systemHead alone collapses actors.
		const key = `${r.tools.join(",")} :: ${r.lastHead.slice(0, 60)}`;
		const cur = byActor.get(key);
		if (cur) cur.count += 1;
		else
			byActor.set(key, {
				count: 1,
				model: r.model,
				tools: r.tools,
				head: r.lastHead,
			});
	}
	process.stdout.write(`\n=== ${stub.records.length} model calls total ===\n`);
	process.stdout.write(
		`=== ${byActor.size} distinct actor fingerprints ===\n\n`,
	);
	for (const [, a] of byActor) {
		process.stdout.write(
			`[${a.count}x] model=${a.model}\n  tools: ${a.tools.join(", ") || "(none)"}\n  system: ${a.head.replace(/\n/g, " ⏎ ")}\n\n`,
		);
	}
	process.stdout.write(`full log: ${logPath}\n`);

	sut.client.close();
	sut.child.kill("SIGKILL");
	await stub.close();
	// Keep the log dir AND the sandbox for inspection.
	process.stdout.write(`(log dir kept: ${logDir})\n`);
	process.stdout.write(`(piHome kept: ${profile.piHome})\n`);
	void rmSync; // retained import guard; dirs intentionally kept
	void profile;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

main().then(
	() => process.exit(0),
	(err) => {
		process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
		process.exit(1);
	},
);

// The LLM-driver: a control CLI + daemon that lets an external coding agent
// (Claude, or another pi) drive a real maestro end to end. This is the pi-native
// realization of the research spike's conclusion — an external driver that
// starts a run, observes it, ANSWERS the agent's questions, and asserts on
// outcomes, over pi's own control surface, with no MCP.
//
//   e2e-driver auth login          # one browser login; refreshes itself after
//   e2e-driver auth status|logout
//   e2e-driver start [--live|--ci] [--multi-model|--sit-models]
//                    [--local-remote] [--keep] [--sock PATH]
//   e2e-driver prompt "<text>" [--steer|--follow-up]
//   e2e-driver poll                # new events + parked questions
//   e2e-driver answer <id> "<value>"
//   e2e-driver state               # pi state + plan/deliverable summary
//   e2e-driver assert              # white-box outcome assertions
//   e2e-driver stop                # tear the SUT + sandbox down
//
// `start` runs the daemon (run it in the background); every other subcommand is a
// thin client that connects over a unix socket, prints one JSON reply, and exits.
// Run via: `node_modules/.bin/jiti test/e2e/driver/cli.ts <subcommand>`
// (or the `npm run e2e:driver -- <subcommand>` script).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForwardingAnswerer } from "./answerer.js";
import { assertEnsemble, assertScenario, readPlan } from "./assertions.js";
import {
	awaitDeviceApproval,
	copilotAuthEntry,
	copilotCredentialPath,
	enableCopilotModels,
	mintCopilotToken,
	readCopilotCredential,
	startDeviceLogin,
} from "./copilot-auth.js";
import { COPILOT_PROFILE, COPILOT_REQUIRED_MODELS } from "./copilot-profile.js";
import { detectStall, keepSystemAwake, STALL_MS } from "./daemon-health.js";
import {
	checkoutRoot,
	type EnvProfile,
	setupCiEnv,
	setupLiveEnv,
} from "./env-profile.js";
import {
	clearCredential,
	credentialPath,
	describeCredential,
	loginToGateway,
	readCredential,
} from "./gateway-auth.js";
import { type LaunchedSut, launchSut } from "./launch.js";
import { MULTI_MODEL_OLLAMA } from "./multi-model-profile.js";
import type { RpcEvent } from "./rpc-client.js";
import {
	ENSEMBLE_METRICS,
	SANDBOX_FEATURES,
	type Scenario,
} from "./scenario.js";
import { seedEnsemblePlan, seedScenarioPlan } from "./seed-plan.js";
import { buildSitProfile, SIT_GATEWAY } from "./sit-profile.js";

const DEFAULT_SOCK = join(tmpdir(), "pi-e2e-driver.sock");

interface ControlRequest {
	readonly cmd: string;
	readonly [key: string]: unknown;
}

// --- daemon ----------------------------------------------------------------

interface DaemonState {
	scenario: Scenario;
	profile: EnvProfile;
	sut: LaunchedSut;
	answerer: ForwardingAnswerer;
	cursor: number;
	server: Server;
	releaseWakeLock: () => void;
}

async function startDaemon(argv: string[]): Promise<void> {
	const sock = flagValue(argv, "--sock") ?? DEFAULT_SOCK;
	if (existsSync(sock)) {
		process.stderr.write(
			`socket ${sock} already exists — is a daemon running? (rm it to reset)\n`,
		);
		process.exit(1);
	}
	const maestroRoot = process.cwd();
	const answerer = new ForwardingAnswerer();
	// Hold the no-idle-sleep assertion for the whole drive. Scoped to this pid,
	// so it releases no matter how the daemon exits.
	const releaseWakeLock = keepSystemAwake();
	const profile = await buildProfile(argv);

	// --seed-plan: write the canned sandbox-features plan straight into the
	// isolated plan store, so the drive opens it with `/plan sandbox-features`
	// and goes directly at execution — no model-dependent plan authoring.
	const seededPlan = argv.includes("--seed-ensemble")
		? seedEnsemblePlan(profile.piHome, profile.repoDir)
		: argv.includes("--seed-plan")
			? seedScenarioPlan(profile.piHome, profile.repoDir)
			: undefined;
	const scenario = argv.includes("--seed-ensemble")
		? ENSEMBLE_METRICS
		: SANDBOX_FEATURES;

	const sut = launchSut({
		maestroRoot,
		repoDir: profile.repoDir,
		piHome: profile.piHome,
		answerer,
		env: profile.env,
		model: profile.model,
		extraExtensions: profile.extraExtensions,
		transcriptPath: join(profile.piHome, "events.jsonl"),
	});

	const state: DaemonState = {
		profile,
		sut,
		answerer,
		scenario,
		cursor: 0,
		server: createServer(),
		releaseWakeLock,
	};

	state.server.on("connection", (socket) => handleConnection(socket, state));
	state.server.listen(sock, () => {
		process.stdout.write(
			`${JSON.stringify({
				ready: true,
				sock,
				repoDir: profile.repoDir,
				piHome: profile.piHome,
				plan: scenario.name,
				planPrompt: scenario.planPrompt,
				...(seededPlan
					? {
							seededPlan,
							seededHint: `Plan pre-seeded — open it with "/plan ${seededPlan}", then drive to execution. Do NOT author deliverables.`,
						}
					: {}),
			})}\n`,
		);
	});

	const shutdown = () => {
		try {
			releaseWakeLock();
			state.sut.client.close();
			state.sut.child.kill("SIGKILL");
			state.profile.teardown();
		} finally {
			rmSync(sock, { force: true });
			process.exit(0);
		}
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// SIGHUP too: a closed terminal or a killed tmux pane sends only this, and
	// without it the drive leaks its disposable GitHub repo, the clone, and the
	// isolated home (it did).
	process.on("SIGHUP", shutdown);
}

async function buildProfile(argv: string[]): Promise<EnvProfile> {
	if (argv.includes("--ci")) {
		const mockProviderExtension = required(argv, "--mock-provider");
		const mockBaseUrl = required(argv, "--mock-url");
		const ghShimDir = required(argv, "--gh-shim");
		return setupCiEnv({
			mockProviderExtension,
			mockBaseUrl,
			ghShimDir,
			keep: argv.includes("--keep"),
		});
	}
	// `--multi-model` installs the built-in ollama multi-model profile (real
	// role→model routing across gpt-oss/qwen3/gemma4). It supplies the provider
	// catalog, the presets/modelSets block, and the planner-seat default; other
	// live flags (--model/--agent-models/…) are ignored in this mode.
	if (argv.includes("--multi-model")) {
		return setupLiveEnv({
			localRemote: argv.includes("--local-remote"),
			keep: argv.includes("--keep"),
			defaultProvider: MULTI_MODEL_OLLAMA.defaultProvider,
			defaultModel: MULTI_MODEL_OLLAMA.defaultModel,
			modelsJsonContent: MULTI_MODEL_OLLAMA.modelsJsonContent,
			models: MULTI_MODEL_OLLAMA.models,
		});
	}
	// `--copilot-models` runs the drive on GitHub Copilot with the DRIVER'S own
	// device-code credential: opus plans and reviews, GPT implements. pi
	// resolves the provider natively, so it refreshes the Copilot token during
	// the run — no bearer frozen into models.json, no mid-drive expiry.
	if (argv.includes("--copilot-models")) {
		const credential = readCopilotCredential();
		if (!credential) {
			throw new Error(
				"no Copilot credential — run `npm run e2e:driver -- auth copilot`",
			);
		}
		const minted = await mintCopilotToken(credential);
		return setupLiveEnv({
			localRemote: argv.includes("--local-remote"),
			keep: argv.includes("--keep"),
			defaultProvider: COPILOT_PROFILE.defaultProvider,
			defaultModel: COPILOT_PROFILE.defaultModel,
			defaultThinkingLevel: COPILOT_PROFILE.defaultThinkingLevel,
			models: COPILOT_PROFILE.models,
			// Correct the Copilot context windows down to the seat's real input
			// caps (only modelOverrides — native oauth is untouched).
			modelsJsonContent: COPILOT_PROFILE.modelsJsonContent,
			isolatedAuth: {
				"github-copilot": copilotAuthEntry(credential, minted),
			},
		});
	}
	// `--sit-models` is the hosted twin: real radicalai-sit gateway models
	// (opus planner/reviews, sol workers) via a generated models.json — no
	// provider extension. Uses the driver's OWN gateway credential and
	// refreshes it here, so a stale token is not a human's problem
	// (`e2e-driver auth login` once, then never again).
	if (argv.includes("--sit-models")) {
		const sit = await buildSitProfile();
		return setupLiveEnv({
			localRemote: argv.includes("--local-remote"),
			keep: argv.includes("--keep"),
			defaultProvider: sit.defaultProvider,
			defaultModel: sit.defaultModel,
			modelsJsonContent: sit.modelsJsonContent,
			models: sit.models,
		});
	}
	const providerExt = flagValue(argv, "--provider-ext");
	// --model sets the isolated settings `defaultModel` (an exact catalog id, so a
	// colon in the id isn't misread as a --model `:<thinking>` suffix).
	const model = flagValue(argv, "--model");
	const agentModelsJson = flagValue(argv, "--agent-models");
	const defaultProvider = flagValue(argv, "--default-provider");
	return setupLiveEnv({
		localRemote: argv.includes("--local-remote"),
		keep: argv.includes("--keep"),
		...(model ? { defaultModel: model } : {}),
		...(defaultProvider ? { defaultProvider } : {}),
		...(agentModelsJson ? { agentModelsJson } : {}),
		...(providerExt ? { providerExtensions: [providerExt] } : {}),
	});
}

async function handleConnection(
	socket: Socket,
	state: DaemonState,
): Promise<void> {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", async (chunk: string) => {
		buffer += chunk;
		const nl = buffer.indexOf("\n");
		if (nl === -1) return;
		const line = buffer.slice(0, nl);
		buffer = "";
		let req: ControlRequest;
		try {
			req = JSON.parse(line) as ControlRequest;
		} catch {
			reply(socket, { ok: false, error: "bad json" });
			return;
		}
		try {
			const result = await dispatch(req, state, socket);
			if (result !== "handled") reply(socket, result);
		} catch (err) {
			reply(socket, { ok: false, error: String((err as Error).message) });
		}
	});
}

async function dispatch(
	req: ControlRequest,
	state: DaemonState,
	socket: Socket,
): Promise<Record<string, unknown> | "handled"> {
	switch (req.cmd) {
		case "ping":
			return { ok: true, pong: true };
		case "prompt": {
			const text = String(req.text ?? "");
			const behavior = await pickBehavior(state, req.behavior);
			await state.sut.client.prompt(text, behavior);
			return { ok: true, sent: text, behavior: behavior ?? "prompt" };
		}
		case "poll": {
			const { events, cursor } = state.sut.client.eventsSince(state.cursor);
			state.cursor = cursor;
			const died = state.sut.died();
			// Death and stall are the two silent failures a poller most needs to
			// learn — both used to be invisible. Death dominates; only probe for a
			// stall when the SUT is still alive.
			const stalled = died ? undefined : await detectStall(state.sut);
			return {
				ok: true,
				events: events.map(summarizeEvent),
				pending: state.answerer.pending(),
				cursor,
				...(died ? { sutDied: died } : {}),
				...(stalled ? { sutStalled: stalled } : {}),
			};
		}
		case "answer": {
			const resolved = state.answerer.resolve(
				String(req.id ?? ""),
				String(req.value ?? ""),
			);
			return { ok: resolved, resolved };
		}
		case "state": {
			// Report death FIRST and do not ask a corpse for its state: the RPC
			// call would hang or answer from cache, which is exactly how a dead
			// drive kept reporting `isStreaming: true`.
			const died = state.sut.died();
			if (died) {
				return { ok: false, sutDied: died, plan: planSummary(state) };
			}
			const pi = await state.sut.client.getState();
			// Alive and streaming but no events for STALL_MS = a hung turn. We
			// already hold `pi`, so judge from it rather than re-querying.
			const sinceMs = state.sut.sinceLastActivityMs();
			const stalled =
				pi.isStreaming && sinceMs >= STALL_MS
					? { sinceMs, thresholdMs: STALL_MS }
					: undefined;
			return {
				ok: true,
				pi,
				plan: planSummary(state),
				...(stalled ? { sutStalled: stalled } : {}),
			};
		}
		case "assert": {
			if (state.scenario.name === ENSEMBLE_METRICS.name) {
				const result = assertEnsemble(
					state.profile.piHome,
					state.profile.repoDir,
					state.scenario,
					{
						parentBranch: "feat/build-metrics",
						minCandidates: 2,
						...(state.profile.env.PI_E2E_GH_STATE
							? { ghStateDir: state.profile.env.PI_E2E_GH_STATE }
							: {}),
					},
				);
				return { ok: result.ok, result };
			}
			const result = assertScenario(
				state.profile.piHome,
				state.profile.repoDir,
				state.scenario,
			);
			return { ok: result.ok, result };
		}
		case "stop": {
			reply(socket, { ok: true, stopping: true });
			setTimeout(() => {
				state.releaseWakeLock();
				state.sut.client.close();
				state.sut.child.kill("SIGKILL");
				state.profile.teardown();
				rmSync(addressOf(state.server), { force: true });
				process.exit(0);
			}, 50);
			return "handled";
		}
		default:
			return { ok: false, error: `unknown cmd: ${req.cmd}` };
	}
}

/** When the agent is mid-stream a plain prompt is rejected; queue instead. */
async function pickBehavior(
	state: DaemonState,
	requested: unknown,
): Promise<"steer" | "followUp" | undefined> {
	if (requested === "steer" || requested === "followUp") return requested;
	const pi = (await state.sut.client.getState()) as { isStreaming?: boolean };
	return pi.isStreaming ? "followUp" : undefined;
}

function planSummary(state: DaemonState): unknown {
	const plan = readPlan(state.profile.piHome, state.scenario.name);
	if (!plan) return { found: false };
	return {
		found: true,
		deliverables: plan.nodes.map((node) => ({
			title: node.title,
			status: node.status,
			prUrl: node.prUrl,
		})),
	};
}

/** Compact an event for the driver: keep type + a few salient fields. */
function summarizeEvent(event: RpcEvent): Record<string, unknown> {
	const keep: Record<string, unknown> = { type: event.type };
	for (const k of ["message", "text", "role", "name", "method", "notifyType"]) {
		if (event[k] !== undefined) keep[k] = event[k];
	}
	return keep;
}

function addressOf(server: Server): string {
	const addr = server.address();
	return typeof addr === "string" ? addr : DEFAULT_SOCK;
}

// --- client ----------------------------------------------------------------

function runClient(cmd: string, argv: string[]): void {
	const sock = flagValue(argv, "--sock") ?? DEFAULT_SOCK;
	const req = buildClientRequest(cmd, argv);
	const socket = connect(sock);
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.includes("\n")) {
			process.stdout.write(buffer);
			socket.end();
		}
	});
	socket.on("error", (err) => {
		process.stderr.write(
			`cannot reach daemon at ${sock}: ${err.message}\n(is \`e2e-driver start\` running?)\n`,
		);
		process.exit(1);
	});
}

function buildClientRequest(cmd: string, argv: string[]): ControlRequest {
	switch (cmd) {
		case "prompt": {
			const text = positional(argv);
			const behavior = argv.includes("--steer")
				? "steer"
				: argv.includes("--follow-up")
					? "followUp"
					: undefined;
			return { cmd, text, ...(behavior ? { behavior } : {}) };
		}
		case "answer": {
			const [id, ...rest] = argv.filter((a) => !a.startsWith("--"));
			return { cmd, id, value: rest.join(" ") };
		}
		default:
			return { cmd };
	}
}

// --- arg helpers -----------------------------------------------------------

function flagValue(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function required(argv: string[], flag: string): string {
	const v = flagValue(argv, flag);
	if (!v) {
		process.stderr.write(`missing required ${flag}\n`);
		process.exit(1);
	}
	return v;
}

/** First non-flag argument (and not a flag's value). */
function positional(argv: string[]): string {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			i++; // skip its value
			continue;
		}
		out.push(argv[i]);
	}
	return out.join(" ");
}

/**
 * `auth login|status|logout` — the driver's own gateway credential. Login is
 * the one step that needs a human at the browser; everything after it (refresh
 * before each drive) is automatic.
 */
async function runAuth(argv: string[]): Promise<void> {
	const action = argv[0] ?? "status";
	if (action === "status") {
		process.stdout.write(
			`${credentialPath()}\n${describeCredential(readCredential())}\n`,
		);
		return;
	}
	if (action === "logout") {
		clearCredential();
		process.stdout.write("driver gateway credential removed\n");
		return;
	}
	if (action === "copilot") {
		const domain = flagValue(argv, "--domain") ?? "dnb.ghe.com";
		const { prompt, deviceCode } = await startDeviceLogin(domain);
		process.stdout.write(
			`Open ${prompt.verificationUri} and enter the code:\n\n` +
				`    ${prompt.userCode}\n\n` +
				`Waiting for approval (expires in ${Math.round(
					prompt.expiresInSeconds / 60,
				)} minutes)…\n`,
		);
		const credential = await awaitDeviceApproval(domain, deviceCode, prompt);
		const minted = await mintCopilotToken(credential);
		// Copilot gates Anthropic/Gemini/Grok models behind a per-model policy
		// acceptance. pi's own login does this; without it a fresh account fails
		// at the first model call with an error about policy, not enablement.
		const enabled = await enableCopilotModels(minted, COPILOT_REQUIRED_MODELS);
		process.stdout.write(
			`signed in to ${credential.domain}` +
				`${minted.sku ? ` (${minted.sku})` : ""}\n` +
				`models enabled: ${enabled.length ? enabled.join(", ") : "none needed"}\n` +
				`stored at ${copilotCredentialPath()}\n`,
		);
		return;
	}
	if (action !== "login") {
		process.stderr.write(
			"usage: e2e-driver auth <login|copilot|status|logout>\n",
		);
		process.exit(1);
	}
	try {
		const credential = await loginToGateway(
			SIT_GATEWAY,
			!argv.includes("--no-open"),
		);
		process.stdout.write(
			`signed in — ${describeCredential(credential)}\nstored at ${credentialPath()}\n`,
		);
	} catch (err) {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	}
}

/**
 * `clean` — remove artifacts a drive left behind.
 *
 * Teardown only cleans the run that owns it, so every abnormal exit leaks a
 * full set: an isolated home, a clone, a bare remote, a gh-shim state dir,
 * worktrees, and (live) a private GitHub repo. Before SIGHUP was handled,
 * closing a terminal did exactly that. Recovery should be one command, not
 * archaeology.
 *
 * Dry by default: it lists what it would remove and removes nothing unless
 * --yes is passed, because it deletes repositories.
 */
async function runClean(argv: string[]): Promise<void> {
	const apply = argv.includes("--yes");
	const tmp = tmpdir();
	const localDirs = readdirSync(tmp)
		.filter((name) => name.startsWith("pi-e2e-"))
		.map((name) => join(tmp, name));
	const worktreesRoot = join(tmp, "worktrees");
	if (existsSync(worktreesRoot)) localDirs.push(worktreesRoot);

	let repos: string[] = [];
	let clones: string[] = [];
	try {
		const owner = execFileSync("gh", ["api", "user", "-q", ".login"], {
			encoding: "utf8",
		}).trim();
		repos = execFileSync(
			"gh",
			[
				"repo",
				"list",
				owner,
				"--limit",
				"100",
				"--json",
				"name",
				"-q",
				".[].name",
			],
			{ encoding: "utf8" },
		)
			.split("\n")
			.map((n) => n.trim())
			.filter((n) => n.startsWith("pi-maestro-e2e-"))
			.map((n) => `${owner}/${n}`);
		const root = checkoutRoot(owner);
		if (existsSync(root)) {
			clones = readdirSync(root)
				.filter((n) => n.startsWith("pi-maestro-e2e-"))
				.map((n) => join(root, n));
			const wt = join(root, "worktrees");
			if (existsSync(wt)) {
				for (const n of readdirSync(wt)) {
					if (n.startsWith("pi-maestro-e2e-")) clones.push(join(wt, n));
				}
			}
		}
	} catch {
		// No gh, or not logged in — local cleanup still works.
	}

	const lines = [
		...localDirs.map((d) => `  local  ${d}`),
		...clones.map((d) => `  clone  ${d}`),
		...repos.map((r) => `  REPO   ${r}`),
	];
	if (lines.length === 0) {
		process.stdout.write("nothing to clean\n");
		return;
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	if (!apply) {
		process.stdout.write(
			`\n${lines.length} item(s). Re-run with --yes to remove them.\n`,
		);
		return;
	}
	for (const dir of [...localDirs, ...clones]) {
		rmSync(dir, { recursive: true, force: true });
	}
	for (const repo of repos) {
		try {
			execFileSync("gh", ["repo", "delete", repo, "--yes"], {
				stdio: "ignore",
			});
		} catch {
			process.stdout.write(`  (could not delete ${repo})\n`);
		}
	}
	process.stdout.write(`removed ${lines.length} item(s)\n`);
}

function reply(socket: Socket, payload: Record<string, unknown>): void {
	socket.write(`${JSON.stringify(payload)}\n`);
	socket.end();
}

// --- entry -----------------------------------------------------------------

const [, , sub, ...rest] = process.argv;
if (sub === "clean") {
	void runClean(rest);
} else if (sub === "auth") {
	void runAuth(rest);
} else if (sub === "start") {
	void startDaemon(rest);
} else if (
	["prompt", "poll", "answer", "state", "assert", "stop", "ping"].includes(
		sub ?? "",
	)
) {
	runClient(sub, rest);
} else {
	process.stderr.write(
		"usage: e2e-driver <auth|clean|start|prompt|poll|answer|state|assert|stop> [...]\n",
	);
	process.exit(1);
}

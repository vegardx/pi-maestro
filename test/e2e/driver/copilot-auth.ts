// GitHub Copilot as the drive's model provider, on a credential the driver
// owns.
//
// Why this is the better auth path than the SIT gateway (see gateway-auth.ts):
// Copilot's long-lived `ghu_` OAuth token is exchanged for a short-lived API
// token and is NOT rotated in the process, so refreshing is non-destructive.
// And pi resolves `github-copilot` natively, so the isolated home gets a real
// provider entry instead of a bearer frozen into models.json — meaning the
// token is refreshed DURING a drive, and a long run can no longer outlive its
// credential.
//
// Login is RFC 8628 device code: no loopback server, no browser automation —
// the operator is shown a URL and a code, and approves in their own browser.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The VS Code Copilot Chat client id pi itself uses (public client). */
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const SCOPES = "read:user";
const POLL_FLOOR_MS = 5_000;

/** Editor identification Copilot's API requires on every call. */
export const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

export interface CopilotCredential {
	/** Long-lived GitHub OAuth token (`ghu_…`) — the durable half. */
	readonly refresh: string;
	/** GitHub host: github.com, or an enterprise host like dnb.ghe.com. */
	readonly domain: string;
}

export interface DeviceCodePrompt {
	readonly userCode: string;
	readonly verificationUri: string;
	readonly expiresInSeconds: number;
	readonly intervalSeconds: number;
}

/**
 * The credential store. PI_E2E_AUTH_DIR redirects it — which TESTS MUST SET:
 * this module's clear/write helpers operate on real files, and a test suite
 * that calls them against the default path deletes the developer's live login
 * (it did, mid-drive, when `npm run check` ran).
 */
export function copilotCredentialPath(): string {
	const dir =
		process.env.PI_E2E_AUTH_DIR ??
		join(dirname(fileURLToPath(import.meta.url)), ".auth");
	return join(dir, "github-copilot.json");
}

export function readCopilotCredential(): CopilotCredential | null {
	try {
		const raw = JSON.parse(readFileSync(copilotCredentialPath(), "utf8"));
		return typeof raw?.refresh === "string" && typeof raw?.domain === "string"
			? (raw as CopilotCredential)
			: null;
	} catch {
		return null;
	}
}

export function writeCopilotCredential(credential: CopilotCredential): void {
	const path = copilotCredentialPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, {
		mode: 0o600,
	});
}

export function clearCopilotCredential(): void {
	rmSync(copilotCredentialPath(), { force: true });
}

async function postForm(
	url: string,
	body: Record<string, string>,
): Promise<Record<string, unknown>> {
	// Pass URLSearchParams itself, NOT its string: fetch then sets
	// `application/x-www-form-urlencoded`. With a string body it sends
	// `text/plain`, and GitHub Enterprise answers 404 Not Found rather than
	// 415 — which reads like a wrong URL and sends you hunting the endpoint.
	// The explicit content-type keeps that true if the body type ever changes.
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
			...COPILOT_HEADERS,
		},
		body: new URLSearchParams(body),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(
			`${url} responded ${response.status}: ${(await response.text()).slice(0, 300)}`,
		);
	}
	return (await response.json()) as Record<string, unknown>;
}

/**
 * Step 1 of the device flow: ask GitHub for a user code. Returns what the
 * operator needs to see; the caller shows it and then awaits {@link
 * awaitDeviceApproval} with the same handle.
 */
export async function startDeviceLogin(domain: string): Promise<{
	prompt: DeviceCodePrompt;
	deviceCode: string;
}> {
	const json = await postForm(`https://${domain}/login/device/code`, {
		client_id: CLIENT_ID,
		scope: SCOPES,
	});
	const deviceCode = String(json.device_code ?? "");
	const userCode = String(json.user_code ?? "");
	if (!deviceCode || !userCode) {
		throw new Error(`unexpected device-code response from ${domain}`);
	}
	return {
		deviceCode,
		prompt: {
			userCode,
			verificationUri: String(
				json.verification_uri ?? `https://${domain}/login/device`,
			),
			expiresInSeconds: Number(json.expires_in ?? 900),
			intervalSeconds: Number(json.interval ?? 5),
		},
	};
}

/**
 * Step 2: poll until the operator approves in the browser. Honours RFC 8628
 * `slow_down` by backing off rather than hammering, and surfaces the terminal
 * errors (`expired_token`, `access_denied`) as themselves.
 */
export async function awaitDeviceApproval(
	domain: string,
	deviceCode: string,
	prompt: DeviceCodePrompt,
): Promise<CopilotCredential> {
	const deadline = Date.now() + prompt.expiresInSeconds * 1000;
	let intervalMs = Math.max(POLL_FLOOR_MS, prompt.intervalSeconds * 1000);

	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		const json = await postForm(`https://${domain}/login/oauth/access_token`, {
			client_id: CLIENT_ID,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		const token = json.access_token;
		if (typeof token === "string" && token.length > 0) {
			const credential = { refresh: token, domain };
			writeCopilotCredential(credential);
			return credential;
		}
		const error = String(json.error ?? "");
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			intervalMs += 5_000;
			continue;
		}
		throw new Error(
			`device login failed: ${error || "unknown error"}${
				json.error_description ? ` — ${json.error_description}` : ""
			}`,
		);
	}
	throw new Error("device login timed out — run the login again");
}

export interface CopilotToken {
	readonly token: string;
	readonly expiresAt: number;
	readonly apiBaseUrl: string;
	readonly sku?: string;
}

/**
 * Accept the per-model policy Copilot gates Anthropic/Gemini/Grok models
 * behind — the programmatic equivalent of enabling a model in Copilot
 * settings. pi's own login does this; skipping it is invisible on an account
 * that already accepted them (via an editor or an earlier login) and fails a
 * fresh one at the first model call, with an error about policy rather than
 * anything naming enablement.
 *
 * Best-effort per model, exactly as pi treats it: a failure here must not
 * fail a login that otherwise succeeded.
 */
export async function enableCopilotModels(
	minted: CopilotToken,
	modelIds: readonly string[],
): Promise<string[]> {
	const enabled: string[] = [];
	await Promise.all(
		modelIds.map(async (id) => {
			try {
				const response = await fetch(
					`${minted.apiBaseUrl}/models/${id}/policy`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${minted.token}`,
							...COPILOT_HEADERS,
							"openai-intent": "chat-policy",
							"x-interaction-type": "chat-policy",
						},
						body: JSON.stringify({ state: "enabled" }),
						signal: AbortSignal.timeout(15_000),
					},
				);
				if (response.ok) enabled.push(id);
			} catch {
				// Network hiccup or an unknown model id — not fatal.
			}
		}),
	);
	return enabled;
}

/**
 * Exchange the durable `ghu_` token for a short-lived Copilot API token. This
 * does NOT rotate the `ghu_` token — the property that makes reusing a Copilot
 * credential safe where reusing a gateway one is not.
 */
export async function mintCopilotToken(
	credential: CopilotCredential,
): Promise<CopilotToken> {
	const response = await fetch(
		`https://api.${credential.domain}/copilot_internal/v2/token`,
		{
			headers: {
				authorization: `token ${credential.refresh}`,
				...COPILOT_HEADERS,
			},
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`minting a Copilot token failed (${response.status}): ${(
				await response.text()
			).slice(0, 300)}`,
		);
	}
	const json = (await response.json()) as {
		token: string;
		expires_at: number;
	};
	const proxy = /proxy-ep=([^;]+)/.exec(json.token)?.[1];
	return {
		token: json.token,
		expiresAt: json.expires_at * 1000,
		apiBaseUrl: proxy
			? `https://${proxy.replace(/^proxy\./, "api.")}`
			: `https://copilot-api.${credential.domain}`,
		...(/sku=([^;]+)/.exec(json.token)?.[1]
			? { sku: /sku=([^;]+)/.exec(json.token)?.[1] }
			: {}),
	};
}

/**
 * The `github-copilot` entry pi expects in an isolated home's auth.json. pi
 * owns refresh from here — which is why a drive can outlive any single token.
 */
export function copilotAuthEntry(
	credential: CopilotCredential,
	minted: CopilotToken,
): Record<string, unknown> {
	return {
		type: "oauth",
		refresh: credential.refresh,
		access: minted.token,
		expires: minted.expiresAt,
		...(credential.domain === "github.com"
			? {}
			: { enterpriseUrl: credential.domain }),
	};
}

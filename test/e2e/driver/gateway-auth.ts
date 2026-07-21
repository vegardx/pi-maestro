// The driver's OWN gateway credential: its own OAuth login, its own store, its
// own refresh cycle.
//
// Why not reuse the developer's pi credential (what we did before): the gateway
// ROTATES the refresh token on every refresh. A driver that refreshes with pi's
// stored credential hands back a new refresh token that pi never sees, so pi's
// copy goes stale and the developer has to /login again. Borrowing a credential
// we also renew is therefore actively destructive, not merely impolite.
//
// With our own credential the drive owns its whole lifecycle: log in once
// (browser, PKCE loopback — the same flow the radicalai provider extension
// runs), then refresh silently forever after, touching nothing of the
// developer's.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_ID = "rgw_cli";
const SCOPES = "inference";
const LOOPBACK_HOST = "127.0.0.1";
/** Refresh this far before real expiry — the gateway issues ~1h tokens. */
const REFRESH_MARGIN_MS = 10 * 60_000;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

export interface GatewayCredential {
	readonly access: string;
	readonly refresh: string;
	/** Absolute ms timestamp of real expiry (no safety margin applied). */
	readonly expires: number;
}

/**
 * Where the driver keeps its credential: beside the driver, gitignored, and
 * deliberately NOT in the developer's pi agent dir.
 */
export function credentialPath(): string {
	const dir =
		process.env.PI_E2E_AUTH_DIR ??
		join(dirname(fileURLToPath(import.meta.url)), ".auth");
	return join(dir, "gateway-sit.json");
}

export function readCredential(): GatewayCredential | null {
	try {
		const raw = JSON.parse(readFileSync(credentialPath(), "utf8"));
		if (
			typeof raw?.access === "string" &&
			typeof raw?.refresh === "string" &&
			typeof raw?.expires === "number"
		) {
			return raw as GatewayCredential;
		}
		return null;
	} catch {
		return null;
	}
}

export function writeCredential(credential: GatewayCredential): void {
	const path = credentialPath();
	mkdirSync(dirname(path), { recursive: true });
	// 0600: it is a bearer token for a paid gateway.
	writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, {
		mode: 0o600,
	});
}

export function clearCredential(): void {
	rmSync(credentialPath(), { force: true });
}

export function describeCredential(
	credential: GatewayCredential | null,
): string {
	if (!credential) return "no stored credential — run `auth login`";
	const minutes = Math.round((credential.expires - Date.now()) / 60_000);
	return minutes > 0
		? `valid for ${minutes} more minute(s); refreshes automatically`
		: `expired ${-minutes} minute(s) ago; refreshes on next use`;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

async function exchange(
	gatewayUrl: string,
	body: Record<string, string>,
): Promise<GatewayCredential> {
	const response = await fetch(`${gatewayUrl}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`gateway token exchange failed (${response.status}): ${(
				await response.text()
			).slice(0, 400)}`,
		);
	}
	const tokens = (await response.json()) as TokenResponse;
	return {
		access: tokens.access_token,
		refresh: tokens.refresh_token,
		expires: Date.now() + tokens.expires_in * 1000,
	};
}

/**
 * A live access token, refreshed if it is close to expiry. The rotated refresh
 * token is persisted BEFORE the caller uses the access token — losing a rotated
 * refresh token means a full re-login, so it must never live only in memory.
 */
export async function liveAccessToken(gatewayUrl: string): Promise<string> {
	const stored = readCredential();
	if (!stored) {
		throw new Error(
			"the e2e driver has no gateway credential yet. Run:\n" +
				"  npm run e2e:driver -- auth login\n" +
				"It opens a browser once; after that the driver refreshes on its own " +
				"and never touches your pi credentials.",
		);
	}
	if (stored.expires - REFRESH_MARGIN_MS > Date.now()) return stored.access;

	const refreshed = await exchange(gatewayUrl, {
		grant_type: "refresh_token",
		refresh_token: stored.refresh,
		client_id: CLIENT_ID,
	}).catch((err) => {
		throw new Error(
			`refreshing the driver's gateway credential failed: ${
				err instanceof Error ? err.message : String(err)
			}\nRun \`npm run e2e:driver -- auth login\` to re-authenticate.`,
		);
	});
	writeCredential(refreshed);
	return refreshed.access;
}

function base64url(input: Buffer): string {
	return input.toString("base64url");
}

/** Browser-based PKCE login against the gateway; returns a fresh credential. */
export async function loginToGateway(
	gatewayUrl: string,
	openBrowser = true,
): Promise<GatewayCredential> {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const state = base64url(randomBytes(16));

	const { port, waitForCode, close } = await startCallbackServer(state);
	const redirectUri = `http://${LOOPBACK_HOST}:${port}/callback`;
	try {
		const authUrl = `${gatewayUrl}/oauth/authorize?${new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
		}).toString()}`;

		process.stdout.write(`Opening the gateway login page:\n${authUrl}\n`);
		if (openBrowser) {
			execFile("open", [authUrl], () => {
				// A failed auto-open is not fatal — the URL is printed above.
			});
		}
		const code = await waitForCode();
		const credential = await exchange(gatewayUrl, {
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CLIENT_ID,
			code_verifier: verifier,
		});
		writeCredential(credential);
		return credential;
	} finally {
		close();
	}
}

interface CallbackServer {
	port: number;
	waitForCode: () => Promise<string>;
	close: () => void;
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	return new Promise((resolveServer, rejectServer) => {
		let settle: ((code: string) => void) | undefined;
		let fail: ((err: Error) => void) | undefined;

		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			const done = (message: string) => {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					`<!doctype html><meta charset="utf-8"><title>pi-maestro e2e</title>` +
						`<body style="font-family:system-ui;padding:3rem;max-width:40rem">` +
						`<h1>pi-maestro e2e</h1><p>${message}</p></body>`,
				);
			};
			if (error) {
				done(`Login failed: ${error}. You can close this tab.`);
				fail?.(new Error(`gateway login failed: ${error}`));
				return;
			}
			// A mismatched state means the response is not ours (CSRF guard).
			if (!code || state !== expectedState) {
				done("Unexpected callback. You can close this tab.");
				fail?.(new Error("gateway login callback failed state validation"));
				return;
			}
			done("Signed in. You can close this tab and return to the terminal.");
			settle?.(code);
		});

		server.on("error", rejectServer);
		server.listen(0, LOOPBACK_HOST, () => {
			const { port } = server.address() as AddressInfo;
			resolveServer({
				port,
				waitForCode: () =>
					new Promise<string>((resolve, reject) => {
						settle = resolve;
						fail = reject;
						setTimeout(
							() =>
								reject(new Error("timed out waiting for the browser login")),
							CALLBACK_TIMEOUT_MS,
						).unref();
					}),
				close: () => server.close(),
			});
		});
	});
}

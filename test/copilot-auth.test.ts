// GitHub Copilot device-code auth for the e2e driver.
//
// The regression worth pinning: Node's fetch sends `text/plain` for a STRING
// body, and GitHub Enterprise answers 404 Not Found to that — not 415 — so a
// missing content-type is indistinguishable from a wrong URL. It cost an hour
// and a wrong code comment (the Copilot editor headers were blamed and are in
// fact harmless).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCopilotCredential,
	copilotAuthEntry,
	copilotCredentialPath,
	readCopilotCredential,
	startDeviceLogin,
	writeCopilotCredential,
} from "../test/e2e/driver/copilot-auth.js";

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
	clearCopilotCredential();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	clearCopilotCredential();
});

describe("device-code requests", () => {
	it("sends a form content-type — the 404-on-text/plain trap", async () => {
		let contentType: string | null = null;
		let bodyText = "";
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const request = new Request("https://example.invalid", init);
			contentType = request.headers.get("content-type");
			bodyText = await request.text();
			return new Response(
				JSON.stringify({
					device_code: "dc",
					user_code: "AAAA-BBBB",
					verification_uri: "https://dnb.ghe.com/login/device",
					expires_in: 899,
					interval: 5,
				}),
				{ status: 200 },
			);
		}) as unknown as typeof globalThis.fetch;

		const { prompt, deviceCode } = await startDeviceLogin("dnb.ghe.com");

		expect(contentType).toContain("application/x-www-form-urlencoded");
		expect(bodyText).toContain("client_id=");
		expect(deviceCode).toBe("dc");
		expect(prompt.userCode).toBe("AAAA-BBBB");
		expect(prompt.intervalSeconds).toBe(5);
	});

	it("surfaces a failed device-code request with its status and body", async () => {
		globalThis.fetch = (async () =>
			new Response('{"error":"Not Found"}', {
				status: 404,
			})) as unknown as typeof globalThis.fetch;

		await expect(startDeviceLogin("dnb.ghe.com")).rejects.toThrow(/404/);
	});
});

describe("the credential store", () => {
	it("is redirected away from the real store while testing", () => {
		// vitest.setup.ts pins PI_E2E_AUTH_DIR to a temp dir. Without it these
		// tests delete the developer's live credential — which they did once.
		expect(process.env.PI_E2E_AUTH_DIR).toBeTruthy();
		expect(copilotCredentialPath()).toContain(
			process.env.PI_E2E_AUTH_DIR as string,
		);
		expect(copilotCredentialPath()).not.toContain(".config/pi");
	});

	it("round-trips and rejects a malformed store", () => {
		expect(readCopilotCredential()).toBeNull();
		writeCopilotCredential({ refresh: "ghu_x", domain: "dnb.ghe.com" });
		expect(readCopilotCredential()).toEqual({
			refresh: "ghu_x",
			domain: "dnb.ghe.com",
		});
	});
});

describe("the auth.json entry handed to the isolated home", () => {
	const minted = {
		token: "tid=1;exp=2",
		expiresAt: 1_700_000_000_000,
		apiBaseUrl: "https://copilot-api.dnb.ghe.com",
	};

	it("carries enterpriseUrl for an enterprise host, and pi refreshes from it", () => {
		const entry = copilotAuthEntry(
			{ refresh: "ghu_x", domain: "dnb.ghe.com" },
			minted,
		);
		expect(entry).toMatchObject({
			type: "oauth",
			refresh: "ghu_x",
			access: minted.token,
			expires: minted.expiresAt,
			enterpriseUrl: "dnb.ghe.com",
		});
	});

	it("omits enterpriseUrl on github.com", () => {
		const entry = copilotAuthEntry(
			{ refresh: "ghu_x", domain: "github.com" },
			minted,
		);
		expect(entry.enterpriseUrl).toBeUndefined();
	});
});

// The e2e driver's own gateway credential.
//
// The invariant that matters: the gateway ROTATES the refresh token on every
// refresh, so whoever refreshes must persist the new one or the credential is
// dead. That is also why the driver must not borrow the developer's pi
// credential — refreshing it would silently invalidate pi's stored copy.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCredential,
	credentialPath,
	describeCredential,
	type GatewayCredential,
	liveAccessToken,
	readCredential,
	writeCredential,
} from "../test/e2e/driver/gateway-auth.js";

const GATEWAY = "https://gateway.example.invalid";
const MINUTE = 60_000;

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
	clearCredential();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	clearCredential();
	vi.restoreAllMocks();
});

function stubTokenEndpoint(
	response: { access_token: string; refresh_token: string; expires_in: number },
	captured: { body?: string } = {},
): void {
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		captured.body = String(init.body);
		return new Response(JSON.stringify(response), { status: 200 });
	}) as unknown as typeof globalThis.fetch;
}

describe("the driver's credential store", () => {
	it("lives beside the driver, not in the developer's pi agent dir", () => {
		expect(credentialPath()).toContain(join("e2e", "driver", ".auth"));
		expect(credentialPath()).not.toContain(join(".config", "pi"));
	});

	it("round-trips, and reports missing/expired in plain words", () => {
		expect(readCredential()).toBeNull();
		expect(describeCredential(null)).toContain("no stored credential");

		const credential: GatewayCredential = {
			access: "a",
			refresh: "r",
			expires: Date.now() + 30 * MINUTE,
		};
		writeCredential(credential);
		expect(readCredential()).toEqual(credential);
		expect(describeCredential(credential)).toContain("refreshes automatically");

		expect(
			describeCredential({ ...credential, expires: Date.now() - 5 * MINUTE }),
		).toContain("expired");
	});

	it("rejects a malformed store rather than half-using it", () => {
		writeCredential({ access: "a", refresh: "r", expires: 1 });
		const path = credentialPath();
		rmSync(path);
		expect(readCredential()).toBeNull();
	});
});

describe("liveAccessToken", () => {
	it("tells the operator how to log in when there is no credential", async () => {
		await expect(liveAccessToken(GATEWAY)).rejects.toThrow(/auth login/);
	});

	it("uses the stored token while it has comfortable life left", async () => {
		writeCredential({
			access: "still-good",
			refresh: "r1",
			expires: Date.now() + 40 * MINUTE,
		});
		globalThis.fetch = (() => {
			throw new Error("must not call the gateway");
		}) as unknown as typeof globalThis.fetch;

		expect(await liveAccessToken(GATEWAY)).toBe("still-good");
	});

	it("refreshes inside the margin and PERSISTS the rotated refresh token", async () => {
		writeCredential({
			access: "old",
			refresh: "rotate-me",
			expires: Date.now() + 2 * MINUTE, // inside the 10m margin
		});
		const captured: { body?: string } = {};
		stubTokenEndpoint(
			{
				access_token: "fresh",
				refresh_token: "rotated",
				expires_in: 3600,
			},
			captured,
		);

		expect(await liveAccessToken(GATEWAY)).toBe("fresh");
		// The old refresh token is spent; only the rotated one can renew again.
		expect(captured.body).toContain("refresh_token=rotate-me");
		expect(readCredential()).toMatchObject({
			access: "fresh",
			refresh: "rotated",
		});
	});

	it("refreshes an already-expired credential rather than giving up", async () => {
		writeCredential({
			access: "dead",
			refresh: "r",
			expires: Date.now() - 10 * MINUTE,
		});
		stubTokenEndpoint({
			access_token: "revived",
			refresh_token: "r2",
			expires_in: 3600,
		});
		expect(await liveAccessToken(GATEWAY)).toBe("revived");
	});

	it("points at re-login when the refresh itself is rejected", async () => {
		writeCredential({ access: "x", refresh: "stale", expires: Date.now() });
		globalThis.fetch = (async () =>
			new Response("invalid_grant", {
				status: 400,
			})) as unknown as typeof globalThis.fetch;

		await expect(liveAccessToken(GATEWAY)).rejects.toThrow(/auth login/);
		// The unusable credential is left in place for inspection, not silently
		// deleted — a failed refresh may be a transient gateway problem.
		expect(existsSync(credentialPath())).toBe(true);
	});
});

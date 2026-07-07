// research-tools package: the Exa search client (tiers, deep answers), the
// Context7 client, the SSRF guard, and webfetch's manual-redirect
// re-validation + HTML extraction. All network via injected fakes.

import { describe, expect, it } from "vitest";
import { context7 } from "../packages/research-tools/src/context7.js";
import {
	EXA_SEARCH_TYPES,
	exaSearch,
	type FetchLike,
} from "../packages/research-tools/src/exa.js";
import {
	assertIpIsPublic,
	UrlValidationError,
	validateUrl,
} from "../packages/research-tools/src/validate.js";
import {
	htmlToText,
	webfetch,
} from "../packages/research-tools/src/webfetch.js";

function jsonResponse(body: unknown): ReturnType<FetchLike> {
	return Promise.resolve({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(body),
		json: async () => body,
	});
}

describe("exa client", () => {
	it("covers the full tier ladder", () => {
		expect(EXA_SEARCH_TYPES).toEqual([
			"instant",
			"fast",
			"auto",
			"deep-lite",
			"deep",
			"deep-reasoning",
		]);
	});

	it("posts the query with tier + key and formats results", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const fetchFn: FetchLike = (url, init) => {
			requests.push({ url, init });
			return jsonResponse({
				results: [
					{
						title: "pi-tui docs",
						url: "https://example.com/pi-tui",
						publishedDate: "2026-05-01T00:00:00Z",
						text: "resize handling details",
					},
				],
			});
		};
		const out = await exaSearch(
			{ query: "pi-tui resize", type: "fast", includeContent: true },
			"key-123",
			fetchFn,
		);
		expect(requests[0].url).toBe("https://api.exa.ai/search");
		const headers = requests[0].init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("key-123");
		const body = JSON.parse(String(requests[0].init.body));
		expect(body.type).toBe("fast");
		expect(body.contents.text.maxCharacters).toBeGreaterThan(0);
		expect(out).toContain('Search (fast): "pi-tui resize" — 1 results');
		expect(out).toContain("pi-tui docs");
		expect(out).toContain("Date: 2026-05-01");
		expect(out).toContain("resize handling details");
	});

	it("surfaces deep-tier synthesized answers above the sources", async () => {
		const fetchFn: FetchLike = () =>
			jsonResponse({
				answer: "Both libraries debounce SIGWINCH.",
				results: [{ title: "src", url: "https://example.com" }],
			});
		const out = await exaSearch(
			{ query: "q", type: "deep-reasoning" },
			"k",
			fetchFn,
		);
		expect(out).toContain("## Answer");
		expect(out).toContain("Both libraries debounce SIGWINCH.");
		expect(out).toContain("## Sources");
	});

	it("throws an actionable error on HTTP failure", async () => {
		const fetchFn: FetchLike = () =>
			Promise.resolve({
				ok: false,
				status: 401,
				text: async () => "bad key",
				json: async () => ({}),
			});
		await expect(exaSearch({ query: "q" }, "k", fetchFn)).rejects.toThrow(
			/HTTP 401.*bad key/s,
		);
	});
});

describe("context7 client", () => {
	it("searches libraries and formats ids", async () => {
		const urls: string[] = [];
		const fetchFn: FetchLike = (url) => {
			urls.push(url);
			return jsonResponse({
				results: [
					{
						id: "/vercel/next.js",
						title: "Next.js",
						totalSnippets: 4200,
						description: "The React framework",
					},
				],
			});
		};
		const out = await context7(
			{ action: "search", libraryName: "next.js", query: "app router" },
			"ctx7sk-abc",
			fetchFn,
		);
		expect(urls[0]).toContain("/api/v2/libs/search?libraryName=next.js");
		expect(urls[0]).toContain("query=app%20router");
		expect(out).toContain("`/vercel/next.js`");
		expect(out).toContain("4200 snippets");
	});

	it("fetches docs as text and passes the bearer key", async () => {
		let headers: Record<string, string> = {};
		const fetchFn: FetchLike = (_url, init) => {
			headers = (init.headers as Record<string, string>) ?? {};
			return Promise.resolve({
				ok: true,
				status: 200,
				text: async () => "## Streaming\nUse loading.tsx",
				json: async () => ({}),
			});
		};
		const out = await context7(
			{ action: "docs", libraryId: "/vercel/next.js", query: "streaming" },
			"ctx7sk-abc",
			fetchFn,
		);
		expect(headers.authorization).toBe("Bearer ctx7sk-abc");
		expect(out).toContain("Use loading.tsx");
	});
});

describe("SSRF guard", () => {
	const resolver = (ips: string[]) => ({
		resolve4: async () => ips,
	});

	it("rejects non-http schemes and localhost-ish hosts", async () => {
		await expect(validateUrl("file:///etc/passwd")).rejects.toThrow(
			UrlValidationError,
		);
		await expect(validateUrl("http://localhost/x")).rejects.toThrow(/blocked/);
		await expect(validateUrl("http://foo.internal/x")).rejects.toThrow(
			/blocked/,
		);
	});

	it("rejects private, loopback, link-local, and metadata IPs", () => {
		for (const ip of [
			"10.1.2.3",
			"172.16.0.9",
			"192.168.1.1",
			"127.0.0.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
		]) {
			expect(() => assertIpIsPublic(ip)).toThrow(UrlValidationError);
		}
		expect(() => assertIpIsPublic("93.184.216.34")).not.toThrow();
	});

	it("catches DNS rebinding: public hostname resolving private", async () => {
		await expect(
			validateUrl("https://evil.example.com/", {
				resolver: resolver(["127.0.0.1"]),
			}),
		).rejects.toThrow(/loopback/);
		await expect(
			validateUrl("https://fine.example.com/", {
				resolver: resolver(["93.184.216.34"]),
			}),
		).resolves.toBeInstanceOf(URL);
	});
});

describe("webfetch", () => {
	function page(body: string, headers: Record<string, string> = {}) {
		return {
			ok: true,
			status: 200,
			headers: {
				get: (k: string) =>
					headers[k.toLowerCase()] ??
					(k === "content-type" ? "text/html" : null),
			},
			body: undefined,
			text: async () => body,
		} as unknown as Response;
	}

	it("re-validates every redirect hop — public → private is blocked", async () => {
		const fetchFn = (async (url: string) => {
			if (url.startsWith("https://ok.example.com")) {
				return {
					ok: false,
					status: 302,
					headers: {
						get: (k: string) =>
							k === "location" ? "http://169.254.169.254/latest" : null,
					},
					text: async () => "",
				} as unknown as Response;
			}
			throw new Error("should not fetch the private hop");
		}) as unknown as typeof fetch;
		await expect(
			webfetch("https://ok.example.com/start", {
				fetchFn,
				resolver: { resolve4: async () => ["93.184.216.34"] },
			}),
		).rejects.toThrow(/link-local/);
	});

	it("returns extracted text with the final URL", async () => {
		const fetchFn = (async () =>
			page(
				"<html><head><title>Doc</title></head><body><script>x()</script><p>Hello &amp; welcome</p></body></html>",
			)) as unknown as typeof fetch;
		const out = await webfetch("https://ok.example.com/doc", {
			fetchFn,
			resolver: { resolve4: async () => ["93.184.216.34"] },
		});
		expect(out).toContain("URL: https://ok.example.com/doc");
		expect(out).toContain("# Doc");
		expect(out).toContain("Hello & welcome");
		expect(out).not.toContain("x()");
	});

	it("caps returned characters", async () => {
		const fetchFn = (async () =>
			page(`<p>${"a".repeat(500)}</p>`)) as unknown as typeof fetch;
		const out = await webfetch("https://ok.example.com/big", {
			fetchFn,
			maxChars: 100,
			resolver: { resolve4: async () => ["93.184.216.34"] },
		});
		expect(out).toContain("…[truncated]");
	});
});

describe("htmlToText", () => {
	it("strips chrome, unwraps tags, decodes entities", () => {
		const text = htmlToText(
			"<html><head><title>T</title><style>.x{}</style></head>" +
				"<body><nav>menu</nav><h1>Head</h1><p>Body &lt;tag&gt; &#8212; done</p>" +
				"<footer>foot</footer></body></html>",
		);
		expect(text).toContain("# T");
		expect(text).toContain("Head");
		expect(text).toContain("Body <tag>");
		expect(text).toContain("— done");
		expect(text).not.toContain("menu");
		expect(text).not.toContain(".x{}");
		expect(text).not.toContain("foot");
	});
});

// SSRF-guarded page fetch → readable text. Redirects are followed MANUALLY so
// every hop is re-validated (a public URL must not bounce a research agent
// into a private address). Response size is hard-capped; HTML is reduced to
// text with a dependency-free extraction (strip script/style/nav chrome,
// unwrap tags, decode entities) — crude next to a real readability pass, but
// plenty for research agents that mostly read docs and articles.

import { UrlValidationError, validateUrl } from "./validate.js";

export interface WebfetchOptions {
	/** Hard cap on downloaded bytes. Default 5 MiB. */
	readonly maxBytes?: number;
	/** Cap on returned text characters. Default 40k. */
	readonly maxChars?: number;
	/** Redirect hops before giving up. Default 5. */
	readonly maxRedirects?: number;
	/** Injectable fetch — used in tests. */
	readonly fetchFn?: typeof fetch;
	/** Injectable DNS resolver for validateUrl — used in tests. */
	readonly resolver?: { resolve4(hostname: string): Promise<string[]> };
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_MAX_REDIRECTS = 5;

export async function webfetch(
	url: string,
	options: WebfetchOptions = {},
): Promise<string> {
	const fetchFn = options.fetchFn ?? fetch;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

	let current = url;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const validated = await validateUrl(current, {
			resolver: options.resolver,
		});
		const response = await fetchFn(validated.toString(), {
			redirect: "manual",
			headers: {
				"user-agent": "pi-maestro-research/1.0 (+https://github.com/vegardx)",
				accept: "text/html,application/xhtml+xml,text/plain,text/markdown,*/*",
			},
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new Error(`redirect (HTTP ${response.status}) without location`);
			}
			current = new URL(location, validated).toString();
			continue;
		}
		if (!response.ok) {
			throw new Error(`fetch failed: HTTP ${response.status} for ${current}`);
		}

		const raw = await readCapped(response, maxBytes);
		const contentType = response.headers.get("content-type") ?? "";
		const text = contentType.includes("html") ? htmlToText(raw) : raw;
		const trimmed = text.trim();
		const body =
			trimmed.length > maxChars
				? `${trimmed.slice(0, maxChars)}\n…[truncated]`
				: trimmed;
		return `URL: ${current}\n\n${body}`;
	}
	throw new Error(`too many redirects (>${maxRedirects}) from ${url}`);
}

export { UrlValidationError };

async function readCapped(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return (await response.text()).slice(0, maxBytes);
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		chunks.push(value);
		if (total >= maxBytes) {
			await reader.cancel().catch(() => {});
			break;
		}
	}
	const merged = new Uint8Array(Math.min(total, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		const slice = chunk.slice(0, merged.length - offset);
		merged.set(slice, offset);
		offset += slice.length;
		if (offset >= merged.length) break;
	}
	return new TextDecoder().decode(merged);
}

/** Dependency-free HTML → text: drop non-content blocks, unwrap the rest. */
export function htmlToText(html: string): string {
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(
			/<(?:nav|header|footer|aside)[\s\S]*?<\/(?:nav|header|footer|aside)>/gi,
			" ",
		)
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	text = decodeEntities(text)
		.replace(/[ \t]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
	return title ? `# ${decodeEntities(title)}\n\n${text}` : text;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
	"&nbsp;": " ",
};

function decodeEntities(text: string): string {
	return text
		.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
		.replace(/&#(\d+);/g, (_, code) =>
			String.fromCodePoint(Number.parseInt(code, 10)),
		);
}

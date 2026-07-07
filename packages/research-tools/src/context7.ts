// Context7 client — direct REST against https://context7.com/api/v2 (no MCP).
// Two operations:
//
//   search — GET /api/v2/libs/search?libraryName=…&query=…  → candidate
//            library ids ranked for the topic
//   docs   — GET /api/v2/context?libraryId=…&query=…        → documentation
//            snippets + code examples for that library, focused on the query
//
// The API works keyless at a low rate limit; CONTEXT7_API_KEY (Bearer,
// `ctx7sk-…`) raises it.

import type { FetchLike } from "./exa.js";

const BASE = "https://context7.com/api/v2";

export interface Context7SearchInput {
	readonly action: "search";
	/** Library name to look up, e.g. "next.js" or "vitest". */
	readonly libraryName: string;
	/** Topic used to rank matches, e.g. "app router streaming". */
	readonly query: string;
}

export interface Context7DocsInput {
	readonly action: "docs";
	/** Context7 library id from a search result, e.g. "/vercel/next.js". */
	readonly libraryId: string;
	/** What to pull documentation about. */
	readonly query: string;
}

export type Context7Input = Context7SearchInput | Context7DocsInput;

interface Context7Library {
	readonly id?: string;
	readonly title?: string;
	readonly description?: string;
	readonly totalSnippets?: number;
	readonly trustScore?: number;
}

export async function context7(
	input: Context7Input,
	apiKey: string | undefined,
	fetchFn: FetchLike = fetch,
): Promise<string> {
	const headers: Record<string, string> = {};
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;

	if (input.action === "search") {
		const url = `${BASE}/libs/search?libraryName=${encodeURIComponent(
			input.libraryName,
		)}&query=${encodeURIComponent(input.query)}`;
		const response = await fetchFn(url, { headers });
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300);
			throw new Error(
				`Context7 search failed (HTTP ${response.status}): ${detail}`,
			);
		}
		const data = (await response.json()) as unknown;
		const libraries: readonly Context7Library[] = Array.isArray(data)
			? (data as readonly Context7Library[])
			: ((data as { results?: readonly Context7Library[] }).results ?? []);
		if (libraries.length === 0) {
			return `No Context7 libraries matched "${input.libraryName}".`;
		}
		const lines = [`Context7 libraries for "${input.libraryName}":`, ""];
		for (const lib of libraries.slice(0, 10)) {
			lines.push(
				`- \`${lib.id ?? "?"}\` — ${lib.title ?? "(untitled)"}` +
					(lib.totalSnippets ? ` (${lib.totalSnippets} snippets)` : ""),
			);
			if (lib.description) lines.push(`  ${lib.description}`);
		}
		lines.push("", 'Fetch docs with action="docs" and the library id.');
		return lines.join("\n");
	}

	const url = `${BASE}/context?libraryId=${encodeURIComponent(
		input.libraryId,
	)}&query=${encodeURIComponent(input.query)}`;
	const response = await fetchFn(url, { headers });
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(
			`Context7 docs failed (HTTP ${response.status}): ${detail}`,
		);
	}
	// The context endpoint returns text (markdown snippets) by default; be
	// tolerant of a JSON envelope.
	const raw = await response.text();
	try {
		const parsed = JSON.parse(raw) as { content?: string; context?: string };
		return parsed.content ?? parsed.context ?? raw;
	} catch {
		return raw;
	}
}

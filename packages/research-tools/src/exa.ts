// Exa search client — direct REST against POST https://api.exa.ai/search
// (no SDK, no MCP). One endpoint serves every tier via `type`:
//
//   instant | fast | auto            — classic search, speed/quality tradeoff
//   deep-lite | deep | deep-reasoning — multi-step research with synthesis
//
// Deep tiers take noticeably longer and burn more credits; the tool
// description steers agents to default to `auto` and escalate deliberately.

export const EXA_SEARCH_TYPES = [
	"instant",
	"fast",
	"auto",
	"deep-lite",
	"deep",
	"deep-reasoning",
] as const;

export type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];

export interface ExaSearchInput {
	readonly query: string;
	readonly type?: ExaSearchType;
	readonly numResults?: number;
	/** Include page text (capped per result) instead of just title/url. */
	readonly includeContent?: boolean;
}

interface ExaResult {
	readonly title?: string;
	readonly url?: string;
	readonly publishedDate?: string;
	readonly author?: string;
	readonly text?: string;
	readonly summary?: string;
}

interface ExaResponse {
	readonly results?: readonly ExaResult[];
	/** Deep tiers return a synthesized answer alongside the sources. */
	readonly answer?: string;
}

export type FetchLike = (
	url: string,
	init: RequestInit,
) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}>;

const EXA_ENDPOINT = "https://api.exa.ai/search";
const TEXT_MAX_CHARACTERS = 2000;

/**
 * Run an Exa search and format the response as markdown. Throws on transport
 * or API errors with an actionable message.
 */
export async function exaSearch(
	input: ExaSearchInput,
	apiKey: string,
	fetchFn: FetchLike = fetch,
): Promise<string> {
	const type = input.type ?? "auto";
	const body: Record<string, unknown> = {
		query: input.query,
		type,
		numResults: input.numResults ?? 6,
	};
	if (input.includeContent) {
		body.contents = { text: { maxCharacters: TEXT_MAX_CHARACTERS } };
	}

	const response = await fetchFn(EXA_ENDPOINT, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(`Exa search failed (HTTP ${response.status}): ${detail}`);
	}

	const data = (await response.json()) as ExaResponse;
	return formatExaResponse(input.query, type, data);
}

function formatExaResponse(
	query: string,
	type: ExaSearchType,
	data: ExaResponse,
): string {
	const results = data.results ?? [];
	const lines: string[] = [
		`Search (${type}): "${query}" — ${results.length} results`,
	];
	if (data.answer) {
		lines.push("", "## Answer", data.answer.trim());
		if (results.length > 0) lines.push("", "## Sources");
	}
	results.forEach((r, i) => {
		lines.push("", `### ${i + 1}. ${r.title || "(no title)"}`);
		if (r.url) lines.push(`URL: ${r.url}`);
		if (r.publishedDate) lines.push(`Date: ${r.publishedDate.slice(0, 10)}`);
		if (r.author) lines.push(`Author: ${r.author}`);
		const text = r.text ?? r.summary;
		if (text) lines.push("", text.trim().slice(0, TEXT_MAX_CHARACTERS));
	});
	return lines.join("\n");
}

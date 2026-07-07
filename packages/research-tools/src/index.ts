// @vegardx/pi-research-tools — web research tools for SPAWNED agents:
//
//   websearch — Exa semantic search (direct REST, tiered: instant→deep-reasoning)
//   webfetch  — SSRF-guarded page fetch → readable text
//   context7  — library documentation via the Context7 REST API
//
// This extension is NOT listed in the root package.json `pi.extensions` — the
// maestro session must not load it (the user's own globally installed search
// tools may occupy the same names). It is passed explicitly via `-e` to
// isolated children (research profile: `-ne -e <this file>`), giving them a
// deterministic tool namespace of builtins + these three.
//
// Keys ride the environment (RpcClient children inherit process.env):
// EXA_API_KEY required for websearch, CONTEXT7_API_KEY optional (rate limit).

import { Type } from "@sinclair/typebox";
import { defineExtension } from "@vegardx/pi-core";
import { context7 } from "./context7.js";
import { EXA_SEARCH_TYPES, type ExaSearchType, exaSearch } from "./exa.js";
import { webfetch } from "./webfetch.js";

export { context7 } from "./context7.js";
export { EXA_SEARCH_TYPES, type ExaSearchType, exaSearch } from "./exa.js";
export {
	assertIpIsPublic,
	parseUrl,
	UrlValidationError,
	validateUrl,
} from "./validate.js";
export { htmlToText, webfetch } from "./webfetch.js";

type ToolText = {
	content: [{ type: "text"; text: string }];
	details: Record<string, never>;
};

function text(value: string): ToolText {
	return { content: [{ type: "text", text: value }], details: {} };
}

function errorText(err: unknown): ToolText {
	return text(err instanceof Error ? err.message : String(err));
}

export default defineExtension(
	{
		name: "research-tools",
		path: "packages/research-tools/src/index.ts",
		doc: "websearch (Exa) + webfetch + context7 for spawned research agents.",
	},
	(pi) => {
		pi.registerTool({
			name: "websearch",
			label: "Web Search",
			description:
				"Search the web via Exa. `tier` trades speed for depth: instant/fast " +
				"for quick lookups, auto (default) for balanced search, deep-lite/" +
				"deep/deep-reasoning for multi-step research that synthesizes an " +
				"answer with sources (slower, use deliberately).",
			promptSnippet:
				"websearch — Exa web search (tiers: instant/fast/auto/deep-lite/deep/deep-reasoning).",
			parameters: Type.Object({
				query: Type.String({ description: "Search query." }),
				tier: Type.Optional(
					Type.Union(
						EXA_SEARCH_TYPES.map((t) => Type.Literal(t)),
						{
							description:
								"Search depth (default auto). Deep tiers synthesize an answer.",
						},
					),
				),
				numResults: Type.Optional(
					Type.Number({ description: "Result count (default 6)." }),
				),
				includeContent: Type.Optional(
					Type.Boolean({
						description: "Include page text excerpts, not just title/URL.",
					}),
				),
			}),
			async execute(_id, params) {
				const apiKey = process.env.EXA_API_KEY;
				if (!apiKey) {
					return text(
						"websearch unavailable: EXA_API_KEY is not set. Fall back to " +
							"codebase research; note the gap in your report.",
					);
				}
				try {
					return text(
						await exaSearch(
							{
								query: params.query,
								type: params.tier as ExaSearchType | undefined,
								numResults: params.numResults,
								includeContent: params.includeContent,
							},
							apiKey,
						),
					);
				} catch (err) {
					return errorText(err);
				}
			},
		});

		pi.registerTool({
			name: "webfetch",
			label: "Web Fetch",
			description:
				"Fetch a public http(s) URL and return its readable text. Use after " +
				"websearch to read a promising source in full.",
			promptSnippet: "webfetch — fetch a URL and return readable text.",
			parameters: Type.Object({
				url: Type.String({ description: "http(s) URL to fetch." }),
				maxChars: Type.Optional(
					Type.Number({
						description: "Cap returned characters (default 40k).",
					}),
				),
			}),
			async execute(_id, params) {
				try {
					return text(
						await webfetch(params.url, { maxChars: params.maxChars }),
					);
				} catch (err) {
					return errorText(err);
				}
			},
		});

		pi.registerTool({
			name: "context7",
			label: "Context7 Docs",
			description:
				'Up-to-date library documentation. action="search" finds a library id ' +
				'by name; action="docs" pulls focused documentation snippets and code ' +
				"examples for that id. Prefer this over websearch for API/library " +
				"reference questions.",
			promptSnippet:
				"context7 — library docs (search for the id, then fetch docs).",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("search"), Type.Literal("docs")]),
				libraryName: Type.Optional(
					Type.String({ description: 'Library name (action="search").' }),
				),
				libraryId: Type.Optional(
					Type.String({
						description: 'Library id like "/vercel/next.js" (action="docs").',
					}),
				),
				query: Type.String({
					description: "Topic to rank matches / focus the docs on.",
				}),
			}),
			async execute(_id, params) {
				try {
					if (params.action === "search") {
						if (!params.libraryName) {
							return text('action="search" requires libraryName');
						}
						return text(
							await context7(
								{
									action: "search",
									libraryName: params.libraryName,
									query: params.query,
								},
								process.env.CONTEXT7_API_KEY,
							),
						);
					}
					if (!params.libraryId) {
						return text('action="docs" requires libraryId');
					}
					return text(
						await context7(
							{
								action: "docs",
								libraryId: params.libraryId,
								query: params.query,
							},
							process.env.CONTEXT7_API_KEY,
						),
					);
				} catch (err) {
					return errorText(err);
				}
			},
		});
	},
);

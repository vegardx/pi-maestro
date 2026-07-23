// Installer-level footer coverage: verifies the custom component preserves
// attention/context priorities without reintroducing the redundant Agents count.

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { installFooter } from "../packages/modes/src/install-footer.js";
import { UsageLedger } from "../packages/modes/src/usage-ledger.js";

function installedFooter(identity?: {
	alias?: string;
	provider?: string;
	region?: string;
}) {
	let factory:
		| ((
				tui: TUI,
				theme: Theme,
				data: ReadonlyFooterDataProvider,
		  ) => { render(width: number): string[] })
		| undefined;
	const setFooter = vi.fn((next: typeof factory) => {
		factory = next;
	});
	const ctx = {
		hasUI: true,
		cwd: "/work/project",
		model: { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
		getContextUsage: () => ({
			tokens: 84_000,
			contextWindow: 200_000,
			percent: 42,
		}),
		ui: { setFooter },
	} as unknown as ExtensionContext;
	const ledger = new UsageLedger();
	ledger.record(
		{ kind: "maestro" },
		{
			input: 10_000,
			output: 2_000,
			cacheRead: 40_000,
			cacheWrite: 0,
			turns: 2,
		},
	);
	installFooter({
		pi: { getThinkingLevel: () => "high" } as unknown as ExtensionAPI,
		ctx,
		getMode: () => "plan",
		getLedger: () => ledger,
		getPendingQuestions: () => 2,
		...(identity ? { getResolvedIdentity: () => identity } : {}),
	});
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const data = {
		getGitBranch: () => "feature",
		getExtensionStatuses: () => new Map([["sync", "SYNC"]]),
	} as unknown as ReadonlyFooterDataProvider;
	const component = factory?.(
		{ requestRender: vi.fn() } as unknown as TUI,
		theme,
		data,
	);
	if (!component) throw new Error("footer was not installed");
	return component;
}

describe("installFooter", () => {
	it("omits Agents while preserving questions and extension status", () => {
		const line = installedFooter().render(120)[0];
		expect(line).toContain("Questions: 2");
		expect(line).toContain("/work/project (feature)");
		expect(line).toContain("SYNC");
		expect(line).not.toContain("Agents:");
		expect(line).toContain("↑50k ↓2k");
		expect(line).toContain("CH 80%");
		// The seat with no v2 alias falls back to the raw model label.
		expect(line).toContain("Model Sonnet 4");
		expect(line).toContain("plan");
	});

	it("keeps mode and attention state at narrow widths", () => {
		const line = installedFooter().render(42)[0];
		expect(line).toContain("Questions: 2");
		expect(line).toContain("plan");
		expect(line).not.toContain("Agents:");
		expect(visibleWidth(line)).toBeLessThanOrEqual(42);
	});

	it("shows resolved identity: alias, gateway, and region", () => {
		const line = installedFooter({
			alias: "GPT 5.6 Sol",
			provider: "github-copilot",
			region: "EEA",
		}).render(140)[0];
		// The alias replaces the raw model label; gateway and region follow.
		expect(line).toContain("Model GPT 5.6 Sol");
		expect(line).toContain("Provider github-copilot");
		expect(line).toContain("Region EEA");
	});
});

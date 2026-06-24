// @vegardx/pi-prompt-assist — input ergonomics. It provides:
//   * ghost-text suggestions: a hidden suggest_next_prompt tool the agent
//     calls once at the end of a turn, surfaced as dim ghost text in the
//     editor (Tab to accept);
//   * the promptAssist.v1 capability (suggest) so other extensions can push
//     ghost text by id;
//   * a programmatic system-prompt addendum (the suggest teaching plus any
//     registered nudges), gated by the systemAddendum flag;
//   * a gated input-transform seam (no built-in transforms in v1).
//
// Every behaviour is independently killable via its feature flag.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { GhostEditor } from "./ghost-editor.js";
import { sanitiseSuggestion } from "./sanitise.js";
import { PromptAssistState } from "./state.js";

export {
	PROMPT_ASSIST_SYSTEM_ADDENDUM,
	sanitiseSuggestion,
} from "./sanitise.js";
export { type InputTransform, PromptAssistState } from "./state.js";

// A component that renders zero lines — the supported way to make a tool call
// invisible (pi has no native hidden-tool flag).
const HIDDEN_RENDER = {
	render: (): string[] => [],
	invalidate: (): void => {},
};

export default defineExtension(
	{
		name: "prompt-assist",
		path: "packages/prompt-assist/src/index.ts",
		doc: "Ghost-text suggestions, system-addendum nudges, gated input transforms.",
	},
	(pi, maestro) => {
		const state = new PromptAssistState();
		let editor: GhostEditor | undefined;
		// Only suggest for turns that began with a real user submission; internal
		// extension-driven turns (modes follow-ups, etc.) bypass the input event.
		let pendingRealInput = false;

		const ghostEnabled = () => maestro.flags.enabled("ghostText");

		pi.on("session_start", (_e, ctx: ExtensionContext) => {
			pendingRealInput = false;
			editor = undefined;
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				editor = new GhostEditor(tui, theme, keybindings);
				return editor;
			});
		});
		pi.on("turn_start", () => editor?.clearGhost());
		pi.on("input", () => {
			editor?.clearGhost();
			pendingRealInput = true;
		});
		pi.on("session_shutdown", () => {
			pendingRealInput = false;
			editor?.clearGhost();
			editor = undefined;
		});

		// Programmatic system-prompt addendum: append the suggest teaching (only
		// while ghost text is on) plus any registered nudges. Chained with other
		// extensions' systemPrompt results by the host.
		pi.on("before_agent_start", (event) => {
			if (!maestro.flags.enabled("systemAddendum")) return;
			const addendum = state.assembleAddendum(ghostEnabled());
			if (!addendum) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${addendum}` };
		});

		// Gated input transform. No-op unless a transform is registered AND the
		// flag is on — the safe default never rewrites the user's text.
		pi.on("input", (event) => {
			if (!maestro.flags.enabled("inputTransform") || !state.hasTransforms)
				return;
			const next = state.applyTransforms(event.text);
			if (next !== event.text) return { action: "transform", text: next };
		});

		pi.registerTool({
			name: "suggest_next_prompt",
			label: "Suggest Next Prompt",
			description:
				"Suggest a one-line prompt to show the developer as ghost text.",
			parameters: Type.Object({
				text: Type.String({
					description:
						"One short sentence directing the developer to do something next, ≤120 chars.",
				}),
			}),
			renderShell: "self",
			renderCall: () => HIDDEN_RENDER,
			renderResult: () => HIDDEN_RENDER,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				// terminate: end the turn here rather than firing a follow-up
				// round-trip after this single trailing tool call.
				const ok = {
					content: [{ type: "text" as const, text: "" }],
					details: {},
					terminate: true,
				};
				if (!ghostEnabled() || !editor || !ctx.hasUI) return ok;
				if (ctx.hasPendingMessages()) return ok;
				if (ctx.ui.getEditorText() !== "") return ok;
				if (!pendingRealInput) return ok;
				pendingRealInput = false;
				const sanitised = sanitiseSuggestion(params.text);
				if (sanitised) editor.setGhost(sanitised);
				return ok;
			},
		});

		maestro.capabilities.register(CAPABILITIES.promptAssist, {
			suggest: (text) => {
				if (!ghostEnabled() || !editor) return;
				const sanitised = sanitiseSuggestion(text);
				if (sanitised) editor.setGhost(sanitised);
			},
		});
	},
);

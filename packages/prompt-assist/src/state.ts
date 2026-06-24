// The pure, terminal-free core of prompt-assist: it tracks registered system-
// prompt nudges and input transforms, and assembles / applies them. The
// extension factory owns the wiring (editor, events, flags); this holds the
// state so it can be tested without a TUI.

import { PROMPT_ASSIST_SYSTEM_ADDENDUM } from "./sanitise.js";

/** Rewrites or augments raw user input. Return undefined to leave it unchanged. */
export type InputTransform = (text: string) => string | undefined;

export class PromptAssistState {
	#nudges: string[] = [];
	#transforms: InputTransform[] = [];

	/**
	 * Register an extra system-prompt nudge (e.g. modes injecting a hint about
	 * the active mode). Returns a disposer that removes exactly this nudge.
	 */
	addNudge(text: string): () => void {
		const trimmed = text.trim();
		if (!trimmed) return () => {};
		this.#nudges.push(trimmed);
		return () => {
			const i = this.#nudges.indexOf(trimmed);
			if (i >= 0) this.#nudges.splice(i, 1);
		};
	}

	/** Register a gated input transform. Returns a disposer. */
	addTransform(fn: InputTransform): () => void {
		this.#transforms.push(fn);
		return () => {
			const i = this.#transforms.indexOf(fn);
			if (i >= 0) this.#transforms.splice(i, 1);
		};
	}

	/**
	 * Build the system-prompt addendum: the always-present suggest teaching plus
	 * any registered nudges, separated by blank lines. Empty string when there
	 * is nothing to add.
	 */
	assembleAddendum(includeSuggestTeaching: boolean): string {
		const parts: string[] = [];
		if (includeSuggestTeaching) parts.push(PROMPT_ASSIST_SYSTEM_ADDENDUM);
		parts.push(...this.#nudges);
		return parts.join("\n\n");
	}

	/**
	 * Run the registered transforms in order; each sees the previous one's
	 * output. Returns the (possibly unchanged) text. With no transforms this is
	 * the identity — the safe default.
	 */
	applyTransforms(text: string): string {
		let out = text;
		for (const fn of this.#transforms) {
			const next = fn(out);
			if (typeof next === "string") out = next;
		}
		return out;
	}

	get hasTransforms(): boolean {
		return this.#transforms.length > 0;
	}
}

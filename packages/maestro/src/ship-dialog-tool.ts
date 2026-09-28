// `plan_ship_dialog`: the one tool the ship decision has, and it decides nothing.
//
// Saying "ship it" in the conversation should reach the same dialog the gate
// opens. It used to reach nothing: the model either answered in prose, or told
// the person to type `/workflow decide <prefix> ship {"ship":true}` — a command
// about a gate whose inputs were on another screen. So there is one tool, and its
// whole contract is stated in its own description: it OPENS the dialog and
// returns. The person answers.
//
// It lives in its own file for the reason `delete-tool.ts` does: a tool is a
// `defineTool` call plus the one decision it is allowed to make, and putting it
// beside the dialogs it opens would make `decide.ts` a module that both renders a
// decision and registers a way to ask for one.
//
// THE PREDICATE IS THE POINT. `ToolRegistry`'s `available` is read at call time,
// so the tool is offered only while a run of this session is actually parked at a
// ship decision — which is the second place this rule would otherwise live, after
// the description that claims it. A model that calls it anyway gets
// `NOTHING_PARKED`, by name, rather than an empty dialog.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { NOTHING_PARKED, openedDialog, SHIP_DIALOG_TOOL } from "./decide.js";

/** What the tool needs and cannot know: what is parked, and how to open it. */
export interface ShipDialogPort {
	/** Is a run of this session parked at a ship decision right now? */
	parked(): boolean;
	/**
	 * Open the dialog for whatever is parked, and return what it was about.
	 *
	 * `undefined` when nothing was parked by the time it ran — a gate decided a
	 * moment earlier is the ordinary race, and it is not an error.
	 *
	 * IT DOES NOT AWAIT THE ANSWER. The dialog belongs to the person, and a tool
	 * call that blocked on it would hold the model's turn open across a decision
	 * that exists precisely to be made without one.
	 */
	open(): { readonly slug: string; readonly runId: string } | undefined;
}

export function createShipDialogTool(port: ShipDialogPort): ToolDefinition {
	return defineTool({
		name: SHIP_DIALOG_TOOL,
		label: "Open the ship dialog",
		description:
			"Open the ship decision of the plan run this session has parked at its " +
			"ship gate, as a dialog with the gate's own inputs in it — every " +
			"deliverable's summary, the review findings by severity, the fixer's " +
			"answer to each, and what is left over. Call it when the person says to " +
			"ship, or asks to see the decision. It DECIDES NOTHING: the person " +
			"answers the dialog. Available only while a run of this session is parked " +
			"at a ship decision.",
		promptSnippet:
			"open the parked ship decision as a dialog for the person to answer. It decides nothing.",
		parameters: Type.Object({}),
		async execute() {
			const opened = port.open();
			return {
				content: [
					{
						type: "text" as const,
						text: opened
							? openedDialog(opened.slug, opened.runId)
							: NOTHING_PARKED,
					},
				],
				details: opened,
			};
		},
	}) as ToolDefinition;
}

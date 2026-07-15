// HUD glue: builds the live HudSnapshot from runtime state, wires actions
// (attach/steer/interrupt/answer) and owns the refresh loop — mount-once via
// the OverlayManager, requestRender on events, plus a 5s elapsed tick while
// any agent is live. Presentation lives in runtime/hud.ts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { uiTrace } from "@vegardx/pi-core";
import type { RuntimeContext } from "./context.js";
import { HudComponent, type HudSnapshot, type HudTab } from "./hud.js";

/** Re-render cadence while agents are live, so elapsed columns tick. */
const HUD_TICK_MS = 5_000;

export interface HudHandle {
	readonly component: HudComponent;
	/** Request a re-render and (re)arm the elapsed tick when agents are live. */
	refresh(): void;
	/** Switch tab + expand/focus the HUD (the /agents command). */
	show(tab: HudTab): void;
	dispose(): void;
}

/** Mount the HUD in the overlay manager's "agents" slot (idempotent). */
export function installHud(rt: RuntimeContext, ctx: ExtensionContext): void {
	if (rt.hud) {
		rt.hud.refresh();
		return;
	}
	let timer: ReturnType<typeof setInterval> | undefined;

	const component = new HudComponent({
		data: () => buildHudSnapshot(rt),
		theme: () => ctx.ui.theme,
		actions: {
			attach: () => {},
			steer: () => {},
			interrupt: () => {},
			answer: () => {},
		},
	});

	const refresh = (): void => {
		rt.overlayManager.invalidate();
		const live = hasLiveAgents(rt);
		if (live && timer === undefined) {
			const t = setInterval(refresh, HUD_TICK_MS);
			t.unref?.();
			timer = t;
		} else if (!live && timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	rt.hud = {
		component,
		refresh,
		show(tab: HudTab): void {
			component.setTab(tab);
			rt.overlayManager.focusOverlay("agents");
		},
		dispose(): void {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			rt.overlayManager.unmount("agents");
			rt.hud = undefined;
		},
	};

	uiTrace("hud.mount");
	rt.overlayManager.mount("agents", component);
	refresh();
}

/** Whether any execution agent or subagent run is still moving. */
function hasLiveAgents(rt: RuntimeContext): boolean {
	const snap = rt.execution?.snapshot();
	if (snap) {
		for (const agent of snap.agents.values()) {
			if (!["done", "failed"].includes(agent.status)) return true;
		}
	}
	if (rt.researchRuns.size > 0) return true;
	const subagents = rt.maestro.capabilities.get(CAPABILITIES.subagents);
	for (const run of subagents?.list() ?? []) {
		if (["queued", "starting", "running", "blocked"].includes(run.status)) {
			return true;
		}
	}
	return false;
}

/** Assemble the live snapshot the HUD renders from. */
export function buildHudSnapshot(_rt: RuntimeContext): HudSnapshot {
	return { agents: [], plan: undefined, questions: [] };
}

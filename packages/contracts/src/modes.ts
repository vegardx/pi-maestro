export const MODE_NAMES = ["plan", "ask", "auto", "hack"] as const;
export const ALL_MODES = MODE_NAMES;
export type ModeName = (typeof MODE_NAMES)[number];
export type CycleModeName = ModeName;

export interface ModeChange {
	readonly mode: ModeName;
	readonly previous: ModeName;
}

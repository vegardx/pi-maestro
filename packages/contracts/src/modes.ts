// Permission modes. Ordered as the Shift+Tab cycle presents them.

export const MODE_NAMES = ["hack", "plan", "ask", "auto"] as const;

export type ModeName = (typeof MODE_NAMES)[number];

export interface ModeChange {
	readonly mode: ModeName;
	readonly previous: ModeName;
}

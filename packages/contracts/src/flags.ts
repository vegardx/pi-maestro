// Feature-flag override vocabulary. The resolver (env > project > global >
// default) lives in @vegardx/pi-settings; this is the shared shape used to
// carry deliberate overrides — e.g. into a spawned child (see SpawnProfile).

export interface FeatureFlagOverrides {
	/** Flag paths to force on, e.g. "modes.fanout". */
	readonly enable?: readonly string[];
	/** Flag paths to force off, e.g. "prompt-assist.transform". */
	readonly disable?: readonly string[];
}

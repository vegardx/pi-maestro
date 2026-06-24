// Background-model vocabulary.
//
// Extensions declare a stable *tier* (what kind of work) and *set* (which
// model family); the user maps those labels to concrete "provider/id" specs
// in settings. No provider/model id is ever hard-coded.

export const TIERS = ["fast", "normal", "heavy"] as const;
export type Tier = (typeof TIERS)[number];

export const BACKGROUND_SETS = ["primary", "secondary"] as const;
export type BackgroundSet = (typeof BACKGROUND_SETS)[number];

export type TierMap = Partial<Record<Tier, string>>;
export type BackgroundModels = Partial<Record<BackgroundSet, TierMap>>;

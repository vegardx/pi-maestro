// Capability registry — the only way extensions talk to each other. A
// provider publishes a versioned capability; a consumer resolves it by id
// (require = hard dep, get = soft dep, whenAvailable = wait for late load),
// never by importing the sibling package. The store is anchored on
// globalThis so a single registry survives module re-evaluation within a
// process and is shared across all extensions in the session.

import type { CapabilityId, CapabilityMap } from "@vegardx/pi-contracts";

interface RegistryState {
	store: Map<CapabilityId, unknown>;
	waiters: Map<CapabilityId, Array<(value: unknown) => void>>;
}

const KEY = "__maestro_capability_registry__";

function state(): RegistryState {
	const g = globalThis as Record<string, unknown>;
	if (!g[KEY]) {
		g[KEY] = {
			store: new Map(),
			waiters: new Map(),
		} satisfies RegistryState;
	}
	return g[KEY] as RegistryState;
}

/**
 * Publish a capability. Returns a disposer that removes it (only if it's
 * still the same instance — a later re-register isn't clobbered).
 */
export function registerCapability<K extends CapabilityId>(
	id: K,
	impl: CapabilityMap[K],
): () => void {
	const s = state();
	s.store.set(id, impl);
	const waiters = s.waiters.get(id);
	if (waiters) {
		s.waiters.delete(id);
		for (const w of waiters) w(impl);
	}
	return () => {
		if (s.store.get(id) === impl) s.store.delete(id);
	};
}

/** Soft lookup — `undefined` when no provider has registered. */
export function getCapability<K extends CapabilityId>(
	id: K,
): CapabilityMap[K] | undefined {
	return state().store.get(id) as CapabilityMap[K] | undefined;
}

/** Hard lookup — throws when the capability is absent. */
export function requireCapability<K extends CapabilityId>(
	id: K,
): CapabilityMap[K] {
	const value = getCapability(id);
	if (value === undefined) {
		throw new Error(`required capability not available: ${id}`);
	}
	return value;
}

/** Resolve now if present, else when a provider registers it. */
export function whenCapabilityAvailable<K extends CapabilityId>(
	id: K,
): Promise<CapabilityMap[K]> {
	const existing = getCapability(id);
	if (existing !== undefined) return Promise.resolve(existing);
	return new Promise<CapabilityMap[K]>((resolve) => {
		const s = state();
		const list = s.waiters.get(id) ?? [];
		list.push((value) => resolve(value as CapabilityMap[K]));
		s.waiters.set(id, list);
	});
}

/** Test seam — wipe the process-global registry between cases. */
export function __resetCapabilityRegistry(): void {
	const s = state();
	s.store.clear();
	s.waiters.clear();
}

/**
 * Per-extension facade handed to the factory. `register` tracks disposers so
 * defineExtension can tear capabilities down on session_shutdown; the lookups
 * delegate to the shared registry.
 */
export interface ExtensionCapabilities {
	register<K extends CapabilityId>(id: K, impl: CapabilityMap[K]): void;
	get<K extends CapabilityId>(id: K): CapabilityMap[K] | undefined;
	require<K extends CapabilityId>(id: K): CapabilityMap[K];
	whenAvailable<K extends CapabilityId>(id: K): Promise<CapabilityMap[K]>;
}

export function createExtensionCapabilities(
	disposers: Array<() => void>,
): ExtensionCapabilities {
	return {
		register: (id, impl) => {
			disposers.push(registerCapability(id, impl));
		},
		get: getCapability,
		require: requireCapability,
		whenAvailable: whenCapabilityAvailable,
	};
}

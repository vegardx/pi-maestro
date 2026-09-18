// The session, as plan validation asks about it.
//
// `PlanHostPort` is a port so that a test can answer its three questions
// without a Pi session, and shared here rather than copied per suite because a
// second fake is a second opinion about what a host is: one that answered
// `hasModel` from a different shape than `registeredProviders` would let a
// refusal message pass a test it should fail.

import type { PlanHostPort } from "../packages/maestro/src/plan.js";

export interface FakeHostOptions {
	/** Models this host has, as the `provider/model` ids a plan pins. */
	readonly models?: readonly string[];
	/** Registered providers. Defaults to the providers of `models`. */
	readonly providers?: readonly string[];
	/** Skills Pi has loaded in this session. */
	readonly skills?: readonly string[];
}

/** A host that has exactly what it was told about, and nothing else. */
export function fakeHost(options: FakeHostOptions = {}): PlanHostPort {
	const models = options.models ?? [];
	const providers = options.providers ?? [
		...new Set(models.map((id) => id.slice(0, id.indexOf("/")))),
	];
	return {
		hasModel: (provider, id) => models.includes(`${provider}/${id}`),
		registeredProviders: () => providers,
		loadedSkills: () => options.skills ?? [],
	};
}

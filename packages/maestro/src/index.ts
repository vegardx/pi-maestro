// packages/maestro — the system packages/modes is being rebuilt into.
//
// This is NOT an extension yet: it is deliberately absent from the root
// manifest's `pi.extensions` list, so importing from it has no registration
// side effects. `packages/modes` remains the live extension and consumes this
// package while subsystems move across one PR at a time. At the cutover the
// manifest entry flips here and both `modes` and `subagents` are deleted.
//
// Import submodules (`@vegardx/pi-maestro/execution-policy`) rather than this
// barrel where the barrel would drag in more than the caller needs.

export {
	describePolicyDeviations,
	type ExecutionPolicyPreset,
	type ExecutionPolicySettings,
	type IsolationTier,
	readExecutionPolicySettings,
} from "./execution-policy.js";

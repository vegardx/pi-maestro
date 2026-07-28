// packages/maestro — the system packages/modes is being rebuilt into.
//
// This is NOT an extension yet: it is deliberately absent from the root
// manifest's `pi.extensions` list, so importing from it has no registration
// side effects. `packages/modes` remains the live extension and consumes this
// package while subsystems move across one PR at a time. At the cutover the
// manifest entry flips here and both `modes` and `subagents` are deleted.
//
// This barrel stays DELIBERATELY thin. Every consumer imports a submodule
// (`@vegardx/pi-maestro/bash-policy`), because a fat barrel would pull the whole
// package — and its peer deps — into callers that wanted one type. It also keeps
// the eventual extension entry point from becoming the thing everyone imports,
// which is where module-lifetime singletons get built.

export {
	describePolicyDeviations,
	type ExecutionPolicyPreset,
	type ExecutionPolicySettings,
	type IsolationTier,
	readExecutionPolicySettings,
} from "./execution-policy.js";

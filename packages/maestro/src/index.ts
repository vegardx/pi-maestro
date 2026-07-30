// packages/maestro — the orchestrator.
//
// The cutover has happened: this IS the extension the manifest loads, and
// `packages/modes`, `packages/subagents` and `packages/rpc` are deleted.
//
// This barrel has no importers — every consumer uses the `./*` subpath export,
// which is what keeps a module-lifetime side effect from travelling on an
// accidental `import from "@vegardx/pi-maestro"`. The extension entry is
// `extension.ts`, not this file.
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

import type { SettingDeclaration } from "@vegardx/pi-contracts";

const recommended = true;

export const EXECUTION_POLICY_SETTINGS = [
	{
		key: "execution.preset",
		label: "Policy preset",
		type: "choice",
		default: "guided",
		group: "execution-policy",
		description:
			"Guided balances protection and flow. Strict adds confirmation; Permissive reduces advisory friction. Individual overrides make the effective policy Custom.",
		options: [
			{
				value: "guided",
				label: "Guided",
				description:
					"Mode-aware routing with safe isolation and visible fallback.",
				recommended,
			},
			{
				value: "strict",
				label: "Strict",
				description: "Prefer strong isolation and confirm all mutations.",
			},
			{
				value: "permissive",
				label: "Permissive",
				description:
					"Reduce guidance and confirmations while retaining invariants.",
				warning: "Permits more direct host execution.",
			},
		],
	},
	{
		key: "execution.toolGuidance",
		label: "Tool guidance",
		type: "choice",
		default: "mode-aware",
		group: "execution-policy",
		description:
			"Prefer exact dedicated tools while preserving compound shell workflows.",
		presetDefaults: {
			guided: "mode-aware",
			strict: "mode-aware",
			permissive: "advisory",
		},
		options: [
			{ value: "mode-aware", label: "Mode-aware", recommended },
			{ value: "advisory", label: "Advisory only" },
			{
				value: "off",
				label: "Off",
				warning: "Workflow invariants still apply.",
			},
		],
	},
	{
		key: "execution.modeRoutes",
		label: "Mode routes",
		type: "choice",
		default: "protected-research",
		group: "execution-policy",
		description:
			"Protect recon and plan, isolate workers, and keep Hack direct.",
		options: [
			{ value: "protected-research", label: "Protected research", recommended },
			{ value: "isolated", label: "Isolate all non-Hack modes" },
			{
				value: "direct",
				label: "Prefer direct",
				warning: "Weakens mode isolation.",
			},
		],
	},
	{
		key: "execution.isolation",
		label: "Isolation tier",
		type: "choice",
		default: "lightweight",
		group: "execution-policy",
		description:
			"Choose process policy, a stronger VM container, or no isolation.",
		presetDefaults: {
			guided: "lightweight",
			strict: "strong",
			permissive: "none",
		},
		options: [
			{ value: "lightweight", label: "Lightweight", recommended },
			{ value: "strong", label: "Strong" },
			{ value: "none", label: "None", warning: "No sandbox boundary." },
		],
	},
	{
		key: "execution.delivery",
		label: "Delivery actions",
		type: "choice",
		default: "dedicated-tools",
		group: "execution-policy",
		description:
			"Keep commit, push, pull request, and merge actions on audited tools.",
		options: [
			{ value: "dedicated-tools", label: "Dedicated tools only", recommended },
		],
	},
	{
		key: "execution.consequential",
		label: "Consequential actions",
		type: "choice",
		default: "confirm",
		group: "execution-policy",
		description:
			"Ask before destructive, external, credential, install, or publish effects.",
		presetDefaults: {
			guided: "confirm",
			strict: "confirm-mutations",
			permissive: "allow",
		},
		options: [
			{ value: "confirm", label: "Confirm consequential", recommended },
			{ value: "confirm-mutations", label: "Confirm all mutations" },
			{
				value: "allow",
				label: "Allow",
				warning: "Hard constraints remain enforced.",
			},
		],
	},
	{
		key: "execution.privilegedRemote",
		label: "Privileged remote behavior",
		type: "choice",
		default: "hack-only",
		group: "execution-policy",
		description:
			"Allow privileged remote administration directly only in explicit Hack mode.",
		options: [
			{ value: "hack-only", label: "Hack mode only", recommended },
			{ value: "confirm", label: "Confirm outside Hack" },
			{ value: "deny", label: "Deny" },
		],
	},
	{
		key: "execution.githubReads",
		label: "GitHub reads",
		type: "choice",
		default: "allow-apparent-reads",
		group: "execution-policy",
		description:
			"Permit apparent GitHub inspection without a brittle command allowlist.",
		options: [
			{
				value: "allow-apparent-reads",
				label: "Allow apparent reads",
				recommended,
			},
			{ value: "confirm", label: "Confirm" },
		],
	},
	{
		key: "execution.unknowns",
		label: "Unknown commands",
		type: "choice",
		default: "isolate",
		group: "execution-policy",
		description:
			"Route uncertain programs to isolation rather than treating them as safe host reads.",
		options: [
			{ value: "isolate", label: "Isolate", recommended },
			{ value: "confirm", label: "Confirm" },
			{ value: "deny", label: "Deny" },
		],
	},
	{
		key: "execution.fallback",
		label: "Unavailable isolation",
		type: "choice",
		default: "fail-closed",
		group: "execution-policy",
		description:
			"Never silently broaden execution when the selected backend is unavailable.",
		options: [
			{ value: "fail-closed", label: "Stop with guidance", recommended },
			{
				value: "confirm",
				label: "Confirm weaker tier",
				warning: "May weaken isolation.",
			},
		],
	},
] as const satisfies readonly SettingDeclaration[];

export const WORKER_POLICY_SETTINGS = [
	{
		key: "workers.dependencyStrategy",
		label: "Dependency strategy",
		type: "choice",
		default: "local-install",
		group: "worker-worktrees",
		description:
			"Prefer worktree-local dependencies backed by shared content caches.",
		options: [
			{ value: "local-install", label: "Local install", recommended },
			{ value: "copy-on-write", label: "Copy-on-write snapshot" },
			{
				value: "explicit-links",
				label: "Explicit shared links",
				warning: "Creates shared mutable state.",
			},
		],
	},
	{
		key: "workers.packageManager",
		label: "Package manager",
		type: "choice",
		default: "auto",
		group: "worker-worktrees",
		description:
			"Detect from lockfiles or select the expected package manager.",
		options: [
			{ value: "auto", label: "Detect from lockfile", recommended },
			{ value: "npm", label: "npm" },
			{ value: "pnpm", label: "pnpm" },
			{ value: "yarn", label: "Yarn" },
			{ value: "bun", label: "Bun" },
		],
	},
	{
		key: "workers.sharedCache",
		label: "Shared package cache",
		type: "choice",
		default: "enabled",
		group: "worker-worktrees",
		description:
			"Share immutable package content caches, not installed dependency trees.",
		options: [
			{ value: "enabled", label: "Enabled", recommended },
			{ value: "disabled", label: "Disabled" },
		],
	},
	{
		key: "workers.failurePolicy",
		label: "Provisioning failure",
		type: "choice",
		default: "stop",
		group: "worker-worktrees",
		description:
			"Do not activate a worker in a partially provisioned environment.",
		options: [{ value: "stop", label: "Stop activation", recommended }],
	},
	{
		key: "workers.repoOverrides",
		label: "Repository overrides",
		type: "string-list",
		default: [],
		group: "worker-worktrees",
		description:
			"Repository-specific provisioning hints; project scope normally owns these values.",
	},
	{
		key: "workers.provisioningReport",
		label: "Provisioning report",
		type: "choice",
		default: "summary",
		group: "worker-worktrees",
		description:
			"Report copied, linked, installed, skipped, and failed provisioning outcomes.",
		options: [
			{ value: "summary", label: "Always summarize", recommended },
			{ value: "problems", label: "Problems only" },
			{ value: "quiet", label: "Quiet" },
		],
	},
] as const satisfies readonly SettingDeclaration[];

export const WORKTREE_SETTINGS = [
	{
		key: "worktree.setup",
		label: "Post-setup command",
		type: "string",
		default: "",
		group: "worker-worktrees",
		description:
			"Run once as an executable plus arguments; shell pipes and redirects are not interpreted.",
	},
	{
		key: "worktree.copy",
		label: "Ignored assets to copy",
		type: "string-list",
		default: [],
		group: "worker-worktrees",
		description:
			"Exact relative ignored paths copied into new worktrees. Higher scopes replace lower lists.",
	},
	{
		key: "worktree.link",
		label: "Ignored assets to link",
		type: "string-list",
		default: [],
		group: "worker-worktrees",
		description: "Exact relative paths intentionally shared with workers.",
		warning: "Links create shared mutable state.",
	},
] as const satisfies readonly SettingDeclaration[];

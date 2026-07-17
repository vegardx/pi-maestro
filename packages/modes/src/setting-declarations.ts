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
				description:
					"Protect Recon/Plan with strong isolation and confirm local mutations elsewhere.",
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
			"Protect Recon and Plan while keeping Auto work direct and Hack explicitly unrestricted.",
		options: [
			{ value: "protected-research", label: "Protected research", recommended },
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
	{
		key: "execution.stopGraceMs",
		label: "Stop grace (ms)",
		type: "number",
		default: 5000,
		group: "execution-policy",
		description:
			"Fleet-wide deadline for cooperative worker shutdown before tmux escalation (0–60000).",
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

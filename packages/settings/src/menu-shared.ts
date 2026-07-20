// Shared plumbing for the /maestro select-driven editor pages: the dialog
// facade over ctx.ui, the configured-provider model browser (auth-filtered —
// #237/#240), and the common list markers. Section pages live in menu.ts and
// menu-catalogs.ts; both build on these.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SelectFn = (
	title: string,
	options: string[],
) => Promise<string | undefined>;
export type InputFn = (
	title: string,
	placeholder?: string,
) => Promise<string | undefined>;
export type ConfirmFn = (title: string, message: string) => Promise<boolean>;

export interface Dialogs {
	readonly select: SelectFn;
	readonly input?: InputFn;
	readonly confirm?: ConfirmFn;
}

export function dialogs(ctx: ExtensionContext): Dialogs | undefined {
	if (!ctx.hasUI || !ctx.ui.select) return undefined;
	return {
		select: ctx.ui.select.bind(ctx.ui) as SelectFn,
		input: ctx.ui.input?.bind(ctx.ui) as InputFn | undefined,
		confirm: ctx.ui.confirm?.bind(ctx.ui) as ConfirmFn | undefined,
	};
}

export const DELETE_MARK = "✕ Delete";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** All registry models grouped by provider (the same catalog /model shows). */
export async function modelsByProvider(
	ctx: ExtensionContext,
): Promise<Map<string, string[]>> {
	const registry = ctx.modelRegistry as unknown as {
		getAll?: () => { provider: string; id: string }[];
		getApiKeyAndHeaders?: (model: {
			provider: string;
			id: string;
		}) => Promise<{ ok: boolean }>;
	};
	const grouped = new Map<string, string[]>();
	const firstModel = new Map<string, { provider: string; id: string }>();
	for (const model of registry.getAll?.() ?? []) {
		const bucket = grouped.get(model.provider) ?? [];
		bucket.push(model.id);
		grouped.set(model.provider, bucket);
		if (!firstModel.has(model.provider)) firstModel.set(model.provider, model);
	}
	// Only CONFIGURED providers — pi's built-in catalog knows about far
	// more providers than this install uses. getProviderAuthStatus is the
	// authoritative signal (getApiKeyAndHeaders answers ok:true for KNOWN
	// providers even with no credential, which is why an ok-probe filtered
	// nothing). Async credential probe is the fallback for older surfaces;
	// if everything filters out, show all rather than none.
	const authStatus = (
		ctx.modelRegistry as unknown as {
			getProviderAuthStatus?: (provider: string) => { configured: boolean };
		}
	).getProviderAuthStatus;
	const configured = new Set<string>();
	if (authStatus) {
		for (const provider of grouped.keys()) {
			try {
				if (authStatus.call(ctx.modelRegistry, provider).configured)
					configured.add(provider);
			} catch {
				// unknown to the status surface — treated as unconfigured
			}
		}
	} else if (registry.getApiKeyAndHeaders) {
		const probes = await Promise.all(
			[...firstModel.entries()].map(async ([provider, model]) => {
				try {
					const auth = (await registry.getApiKeyAndHeaders?.(model)) as
						| { ok: boolean; apiKey?: string; headers?: Record<string, string> }
						| undefined;
					const hasCredential = Boolean(
						auth?.ok && (auth.apiKey || Object.keys(auth.headers ?? {}).length),
					);
					return { provider, ok: hasCredential };
				} catch {
					return { provider, ok: false };
				}
			}),
		);
		for (const probe of probes) if (probe.ok) configured.add(probe.provider);
	}
	if (configured.size > 0) {
		for (const provider of [...grouped.keys()])
			if (!configured.has(provider)) grouped.delete(provider);
	}
	for (const bucket of grouped.values()) bucket.sort();
	return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Pick a model ref via the registry: [session →] provider → model, with a
 * manual-entry escape hatch for models pi has not cached yet. Concrete-model
 * pickers (targets, catalog entries) pass allowSession:false — those slots
 * hold the exact model the live /model choice is matched against.
 */
export async function pickModelRef(
	ctx: ExtensionContext,
	ui: Dialogs,
	opts: { allowSession?: boolean } = {},
): Promise<string | undefined> {
	const SESSION_ENTRY = "session — the live session model";
	const MANUAL_ENTRY = "Type a ref manually… (provider/model)";
	const allowSession = opts.allowSession ?? true;
	const providers = await modelsByProvider(ctx);
	while (true) {
		const picked = await ui.select(
			allowSession ? "Model for this option" : "Model — which provider?",
			[
				...(allowSession ? [SESSION_ENTRY] : []),
				...[...providers.entries()].map(
					([provider, ids]) => `${provider} — ${ids.length} model(s)`,
				),
				MANUAL_ENTRY,
			],
		);
		if (!picked) return undefined;
		if (picked === SESSION_ENTRY) return "session";
		if (picked === MANUAL_ENTRY) {
			if (!ui.input) return undefined;
			const typed = (
				await ui.input("Model ref (provider/model)", "provider/model")
			)?.trim();
			if (typed) return typed;
			continue;
		}
		const provider = picked.split(" ")[0];
		const ids = providers.get(provider) ?? [];
		const id = await ui.select(`${provider} — which model?`, ids);
		if (id) return `${provider}/${id}`;
		// Esc from the model list returns to the provider picker.
	}
}

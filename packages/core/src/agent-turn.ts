// runAgentTurn — the shared primitive for "send the model a message, let it
// run a turn, hand back its text". commit (shipDeliverable), modes
// (seeding/summaries), and subagents all build on this instead of
// re-deriving the idle-wait dance.
//
// It works from a plain ExtensionContext (no ExtensionCommandContext /
// waitForIdle), because callers may only have the bare context. We install one
// shared agent_settled listener per `pi` and queue resolvers behind it.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TURN_CUSTOM_TYPE = "maestro.core.turn";

const installedFor = new WeakSet<object>();
const idleResolvers = new WeakMap<object, Array<() => void>>();

function ensureIdleListener(pi: ExtensionAPI): void {
	if (installedFor.has(pi)) return;
	installedFor.add(pi);
	idleResolvers.set(pi, []);
	pi.on("agent_settled", () => {
		// One microtask of slack so post-turn state settles before callers
		// read the transcript.
		queueMicrotask(() => {
			const list = idleResolvers.get(pi) ?? [];
			idleResolvers.set(pi, []);
			for (const r of list) r();
		});
	});
}

function waitForIdle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	timeoutMs?: number,
): Promise<void> {
	ensureIdleListener(pi);
	if (ctx.isIdle()) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const list = idleResolvers.get(pi);
		if (!list) {
			resolve();
			return;
		}
		// A bounded wait rejects if the nested turn never settles — a hung stream
		// (or a nested turn that cannot start) must not block the caller forever.
		// The resolver is removed from the queue on timeout so a late settlement
		// does not fire it. See nameDraftFromModel (turn_end) for why this matters.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settle = (): void => {
			if (timer) clearTimeout(timer);
			resolve();
		};
		list.push(settle);
		if (timeoutMs && timeoutMs > 0) {
			timer = setTimeout(() => {
				const current = idleResolvers.get(pi);
				const index = current?.indexOf(settle) ?? -1;
				if (index >= 0) current?.splice(index, 1);
				reject(new Error(`runAgentTurn: no settlement within ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
		}
	});
}

function lastAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as
			| { type?: string; message?: { role?: string; content?: unknown } }
			| undefined;
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					parts.push((block as { text: string }).text);
				}
			}
			if (parts.length > 0) return parts.join("\n\n");
		}
	}
	return "";
}

/**
 * Send `message` to the model (silent — not shown as a user message), wait
 * for the turn to finish, and return the assistant's text. Returns an empty
 * string if the turn produced no text.
 */
export async function runAgentTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	message: string,
	opts?: { readonly timeoutMs?: number },
): Promise<string> {
	ensureIdleListener(pi);
	pi.sendMessage(
		{
			customType: TURN_CUSTOM_TYPE,
			content: message,
			display: false,
			details: {},
		},
		{ triggerTurn: true },
	);
	await waitForIdle(pi, ctx, opts?.timeoutMs);
	return lastAssistantText(ctx);
}

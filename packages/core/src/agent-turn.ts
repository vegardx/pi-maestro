// runAgentTurn — the shared primitive for "send the model a message, let it
// run a turn, hand back its text". commit (shipDeliverable), modes
// (seeding/summaries), and subagents all build on this instead of
// re-deriving the idle-wait dance.
//
// It works from a plain ExtensionContext (no ExtensionCommandContext /
// waitForIdle), because callers may only have the bare context. We install one
// shared listener pair per `pi` and queue waiters behind it.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TURN_CUSTOM_TYPE = "maestro.core.turn";

interface Waiter {
	readonly turn: number;
	/** Whether the run carrying this turn's message has delivered it. */
	delivered: boolean;
	readonly settle: (aborted: boolean) => void;
}

const installedFor = new WeakSet<object>();
const waitersFor = new WeakMap<object, Waiter[]>();
let nextTurn = 0;

function turnOf(message: unknown): number | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { customType, details } = message as {
		customType?: unknown;
		details?: unknown;
	};
	if (customType !== TURN_CUSTOM_TYPE) return undefined;
	const turn = (details as { turn?: unknown } | undefined)?.turn;
	return typeof turn === "number" ? turn : undefined;
}

/**
 * A waiter settles on the first `agent_settled` AFTER its message was
 * delivered, never on the session reading idle. Pi defers a run requested
 * while `agent_settled` handlers are running and they still read idle, so an
 * idle check (or the settlement being dispatched) would hand back the previous
 * turn's text.
 */
function ensureListeners(pi: ExtensionAPI): void {
	if (installedFor.has(pi)) return;
	installedFor.add(pi);
	waitersFor.set(pi, []);
	pi.on("message_end", (event) => {
		const turn = turnOf(event.message);
		if (turn === undefined) return;
		for (const waiter of waitersFor.get(pi) ?? [])
			if (waiter.turn === turn) waiter.delivered = true;
	});
	pi.on("agent_settled", (event) => {
		// One microtask of slack so post-turn state settles before callers
		// read the transcript.
		queueMicrotask(() => {
			const waiters = waitersFor.get(pi) ?? [];
			waitersFor.set(
				pi,
				waiters.filter((waiter) => !waiter.delivered),
			);
			for (const waiter of waiters)
				if (waiter.delivered) waiter.settle(event.aborted);
		});
	});
}

/**
 * Whether the run that delivers `turn` was aborted, once it settles.
 *
 * A run whose start throws (in compaction or `before_agent_start`) clears the
 * busy state without delivering or settling, so `timeoutMs` is the only bound
 * on that case.
 */
function settlementOf(
	pi: ExtensionAPI,
	turn: number,
	timeoutMs?: number,
): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const waiters = waitersFor.get(pi);
		if (!waiters) {
			reject(new Error("runAgentTurn: its listeners are not installed"));
			return;
		}
		// A bounded wait rejects if the nested turn never settles — a hung stream
		// (or a nested turn that cannot start) must not block the caller forever.
		// The waiter is removed on timeout so a late settlement does not fire it.
		// See nameDraftFromModel (turn_end) for why this matters.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waiter: Waiter = {
			turn,
			delivered: false,
			settle: (aborted) => {
				if (timer) clearTimeout(timer);
				resolve(aborted);
			},
		};
		waiters.push(waiter);
		if (timeoutMs && timeoutMs > 0) {
			timer = setTimeout(() => {
				const current = waitersFor.get(pi) ?? [];
				waitersFor.set(
					pi,
					current.filter((other) => other !== waiter),
				);
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
 * string if the turn produced no text or was aborted, since an aborted turn's
 * last text is not an answer.
 *
 * Since Pi 1.2 the run this starts goes through `before_agent_start` with
 * `messageType: "custom"`, and carries any pending `nextTurn` messages.
 */
export async function runAgentTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	message: string,
	opts?: { readonly timeoutMs?: number },
): Promise<string> {
	ensureListeners(pi);
	nextTurn += 1;
	const turn = nextTurn;
	const settled = settlementOf(pi, turn, opts?.timeoutMs);
	pi.sendMessage(
		{
			customType: TURN_CUSTOM_TYPE,
			content: message,
			display: false,
			details: { turn },
		},
		{ triggerTurn: true },
	);
	const aborted = await settled;
	return aborted ? "" : lastAssistantText(ctx);
}

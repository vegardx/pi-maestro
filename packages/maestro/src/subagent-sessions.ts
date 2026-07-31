// The subagents a caller holds: a per-process map of live reader sessions.
//
// Lifetime here IS ownership. A read-only agent exists only as an entry in
// this map, so "created" and "someone is waiting" are the same event — there
// is no relationship enum declaring that any more, and there does not need to
// be, because there is no way to hold a reader without being the one it
// answers to. (That used to be a written rule, from the days a review panel's
// six real findings reached a PR body reading "(agent produced no summary)":
// the readers had been detached from anyone who was waiting on them.)
//
// "One-shot" is not a kind of subagent — it is a caller choosing not to ask
// twice. Every session started here stays held and re-askable by id until its
// caller finishes, which is what makes a follow-up one more turn in a
// conversation that kept its context rather than a fresh reader re-reading
// the world. The list a caller sees derives from this map, so it cannot
// drift: an unknown id is a lookup miss naming the real ids, because the map
// is the permission.
//
// Teardown is structural. These sessions are child processes of the caller
// and die with it; `stopAll` on shutdown is hygiene — an orderly exit — not
// the mechanism that ends them.

import type { AgentKind } from "./agent.js";
import {
	guardReadOnlySpawn,
	promptForAnswer,
	type ReadOnlySession,
	type ReadOnlySessionFactory,
	type ReadOnlySpawn,
} from "./spawn.js";

/** What a held session is doing right now. One caller, one question at a time. */
export type SubagentState = "answering" | "idle";

/** The facts `list()` reports. Derived from the live map, never stored apart. */
export interface HeldSubagent {
	readonly id: string;
	readonly persona: string;
	readonly modelId?: string;
	readonly family?: string;
	readonly state: SubagentState;
	/** Questions this session has been asked, the opener included. */
	readonly asked: number;
}

export interface SubagentStart {
	readonly persona: string;
	readonly spawn: ReadOnlySpawn;
	/** The model family, when routing chose one — carried for the listing. */
	readonly family?: string;
}

interface Held {
	readonly id: string;
	readonly persona: string;
	readonly kind: AgentKind;
	readonly modelId?: string;
	readonly family?: string;
	readonly session: ReadOnlySession;
	state: SubagentState;
	asked: number;
}

/** Hears every change to the held map, as the whole map. */
export type SubagentsChanged = (held: readonly HeldSubagent[]) => void;

export class SubagentSessions {
	private readonly held = new Map<string, Held>();
	/** Per-persona counters, so ids read `code-review-2`, not a random token. */
	private readonly counters = new Map<string, number>();
	private listener: SubagentsChanged | undefined;

	constructor(private readonly open: ReadOnlySessionFactory) {}

	/**
	 * Report every change to the held map — a start, a turn beginning or ending,
	 * a teardown. The listener gets the FULL current list, never a delta: a
	 * snapshot that arrives late or doubled still says the truth, so there is no
	 * resync protocol to get wrong. This is how a worker's held readers become
	 * visible one level up — the maestro folds these snapshots into the seat's
	 * own listing.
	 */
	onChange(listener: SubagentsChanged): void {
		this.listener = listener;
	}

	/**
	 * Open a session, ask the opening question, and KEEP the session.
	 *
	 * The entry goes into the map before the first answer arrives, because a
	 * subagent that exists is a subagent someone is waiting on — `list()`
	 * during a long first turn shows it `answering`, which is true.
	 */
	async start(opts: SubagentStart): Promise<{ id: string; answer: string }> {
		guardReadOnlySpawn(opts.spawn);

		const n = (this.counters.get(opts.persona) ?? 0) + 1;
		this.counters.set(opts.persona, n);
		const id = `${opts.persona}-${n}`;

		const session = await this.open(opts.spawn);
		const entry: Held = {
			id,
			persona: opts.persona,
			kind: opts.spawn.kind,
			...(opts.spawn.model ? { modelId: opts.spawn.model } : {}),
			...(opts.family ? { family: opts.family } : {}),
			session,
			state: "answering",
			asked: 0,
		};
		this.held.set(id, entry);
		this.changed();

		try {
			await session.start();
		} catch (error) {
			// Never came up: there is no conversation to hold. Anything else that
			// goes wrong AFTER this point leaves the entry in place — see `turn`.
			this.held.delete(id);
			this.changed();
			await session.stop().catch(() => {});
			throw error;
		}
		const answer = await this.turn(entry, opts.spawn.prompt);
		return { id, answer };
	}

	/**
	 * One more turn in the held conversation. The whole point of holding it:
	 * the reader still has everything it read the first time.
	 */
	async askAgain(id: string, question: string): Promise<string> {
		const entry = this.held.get(id);
		if (!entry) {
			// A corrective miss, not a permission check. The map is the permission,
			// so the error's job is to name what the caller actually holds.
			const ids = [...this.held.keys()];
			throw new Error(
				ids.length > 0
					? `no subagent \`${id}\` — yours are: ${ids.join(", ")}`
					: `no subagent \`${id}\` — you hold none; start one with {persona, question}`,
			);
		}
		if (entry.state === "answering")
			throw new Error(
				`subagent \`${id}\` is still answering — one question at a time: you are its only asker, so the answer on its way is yours`,
			);
		return this.turn(entry, question);
	}

	list(): readonly HeldSubagent[] {
		return [...this.held.values()].map((entry) => ({
			id: entry.id,
			persona: entry.persona,
			...(entry.modelId ? { modelId: entry.modelId } : {}),
			...(entry.family ? { family: entry.family } : {}),
			state: entry.state,
			asked: entry.asked,
		}));
	}

	/**
	 * Stop everything, tolerating individual failures — a session that will not
	 * stop is a process the exiting caller's own death reaps anyway.
	 */
	async stopAll(): Promise<void> {
		const stopping = [...this.held.values()].map((entry) =>
			entry.session.stop().catch(() => {}),
		);
		this.held.clear();
		this.changed();
		await Promise.all(stopping);
	}

	private async turn(entry: Held, question: string): Promise<string> {
		entry.state = "answering";
		entry.asked += 1;
		this.changed();
		try {
			return await promptForAnswer(entry.session, entry.kind, question);
		} finally {
			// Back to idle whatever happened. An empty answer (`EmptyAnswer`) is
			// the reader failing to report, not the session dying — the caller may
			// well want to ask again, differently, and tearing the session down
			// here would punish exactly that.
			entry.state = "idle";
			this.changed();
		}
	}

	private changed(): void {
		this.listener?.(this.list());
	}
}

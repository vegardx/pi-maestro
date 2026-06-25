import type { AskCapabilityV1, Questionnaire } from "@vegardx/pi-contracts";

export class ModesAskQueue {
	private pending: Questionnaire[] = [];

	get size(): number {
		return this.pending.reduce((n, q) => n + q.length, 0);
	}

	enqueue(questions: Questionnaire): void {
		if (questions.length === 0) return;
		this.pending.push(questions);
	}

	flushTo(ask: AskCapabilityV1 | undefined): number {
		if (!ask || this.pending.length === 0) return 0;
		const flattened = this.pending.flat();
		this.pending = [];
		ask.queue(flattened);
		return flattened.length;
	}

	clear(): void {
		this.pending = [];
	}
}

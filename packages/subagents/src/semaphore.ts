// FIFO, abort-aware concurrency semaphore. Caps how many runs (foreground +
// background combined) execute at once; waiters are served in arrival order.
// A waiter whose AbortSignal fires is removed from the queue and its acquire
// rejects, so backpressure never strands a cancelled caller.

export interface Semaphore {
	/** Resolves with a release fn once a slot is free. Rejects if aborted. */
	acquire(signal?: AbortSignal): Promise<() => void>;
	readonly limit: number;
	readonly active: number;
	readonly waiting: number;
}

interface Waiter {
	readonly resolve: (release: () => void) => void;
	readonly reject: (err: Error) => void;
	settled: boolean;
	cleanup?: () => void;
}

export function createSemaphore(limit: number): Semaphore {
	if (limit < 1) throw new Error("semaphore limit must be >= 1");
	let active = 0;
	const queue: Waiter[] = [];

	function release(): void {
		active--;
		pump();
	}

	function pump(): void {
		while (active < limit && queue.length > 0) {
			const waiter = queue.shift();
			if (!waiter || waiter.settled) continue;
			waiter.settled = true;
			waiter.cleanup?.();
			active++;
			let released = false;
			waiter.resolve(() => {
				if (released) return;
				released = true;
				release();
			});
		}
	}

	return {
		get limit() {
			return limit;
		},
		get active() {
			return active;
		},
		get waiting() {
			return queue.length;
		},
		acquire(signal) {
			if (signal?.aborted) {
				return Promise.reject(abortError());
			}
			return new Promise<() => void>((resolve, reject) => {
				const waiter: Waiter = { resolve, reject, settled: false };
				if (signal) {
					const onAbort = () => {
						if (waiter.settled) return;
						waiter.settled = true;
						const i = queue.indexOf(waiter);
						if (i >= 0) queue.splice(i, 1);
						reject(abortError());
					};
					signal.addEventListener("abort", onAbort, { once: true });
					waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
				}
				queue.push(waiter);
				pump();
			});
		},
	};
}

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

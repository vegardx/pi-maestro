// An `Answerer` turns a maestro `extension_ui_request` dialog into the value the
// driver sends back. This is the pi-native equivalent of an agent SDK's
// per-decision permission/answer callback — and the piece the research spike
// flagged as mandatory for autonomy: a real driver must *answer questions*, not
// merely approve tools.
//
// Two implementations:
//   • ScriptedAnswerer  — a deterministic rule table (used by the CI driver).
//   • ForwardingAnswerer — parks each request and hands it to an out-of-process
//                          agent to answer (used by the LLM-driver daemon).

export interface UiSelectRequest {
	readonly type: "extension_ui_request";
	readonly id: string;
	readonly method: "select";
	readonly title?: string;
	readonly message?: string;
	readonly options: string[];
	readonly timeout?: number;
}

export interface UiConfirmRequest {
	readonly type: "extension_ui_request";
	readonly id: string;
	readonly method: "confirm";
	readonly title?: string;
	readonly message?: string;
	readonly timeout?: number;
}

export interface UiInputRequest {
	readonly type: "extension_ui_request";
	readonly id: string;
	readonly method: "input";
	readonly title?: string;
	readonly placeholder?: string;
	readonly timeout?: number;
}

export interface UiEditorRequest {
	readonly type: "extension_ui_request";
	readonly id: string;
	readonly method: "editor";
	readonly title?: string;
	readonly prefill?: string;
	readonly timeout?: number;
}

/** Fire-and-forget notifications; no response is expected for these. */
export interface UiNotifyRequest {
	readonly type: "extension_ui_request";
	readonly id: string;
	readonly method:
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text";
	readonly [key: string]: unknown;
}

export type UiDialogRequest =
	| UiSelectRequest
	| UiConfirmRequest
	| UiInputRequest
	| UiEditorRequest
	| UiNotifyRequest;

export interface SelectAnswer {
	value?: string;
	cancelled?: boolean;
}
export interface ConfirmAnswer {
	confirmed?: boolean;
	cancelled?: boolean;
}
export interface TextAnswer {
	value?: string;
	cancelled?: boolean;
}

export interface Answerer {
	select(req: UiSelectRequest): Promise<SelectAnswer>;
	confirm(req: UiConfirmRequest): Promise<ConfirmAnswer>;
	input(req: UiInputRequest): Promise<TextAnswer>;
	editor(req: UiEditorRequest): Promise<TextAnswer>;
}

// --- ScriptedAnswerer ------------------------------------------------------

/**
 * A rule matches a select dialog by a substring of its title/message and picks
 * an option. The first rule whose `match` is found (case-insensitive) wins; its
 * `prefer` list is scanned against the offered options in order.
 */
export interface SelectRule {
	readonly match: string;
	readonly prefer: string[];
}

export interface ScriptedAnswererOptions {
	/** Ordered select rules; the first matching rule chooses the option. */
	readonly selectRules?: SelectRule[];
	/** Default confirm answer when no rule matches (defaults to `true`). */
	readonly confirmDefault?: boolean;
	/** Default free-text answer for input/editor dialogs. */
	readonly textDefault?: string;
	/** Called for every dialog, for logging/observability. */
	readonly onDialog?: (req: UiDialogRequest, answer: unknown) => void;
}

/**
 * Deterministic answers for the scripted driver. The guiding principle is
 * "push the deliverables toward shipped": prefer options that advance execution
 * (e.g. the transition gate's "Enter execution"), and fall back to the first
 * offered option so the run never deadlocks on an unmodelled prompt.
 */
export class ScriptedAnswerer implements Answerer {
	private readonly rules: SelectRule[];
	private readonly confirmDefault: boolean;
	private readonly textDefault: string;
	private readonly onDialog?: (req: UiDialogRequest, answer: unknown) => void;

	constructor(opts: ScriptedAnswererOptions = {}) {
		this.rules = opts.selectRules ?? DEFAULT_SELECT_RULES;
		this.confirmDefault = opts.confirmDefault ?? true;
		this.textDefault = opts.textDefault ?? "";
		this.onDialog = opts.onDialog;
	}

	async select(req: UiSelectRequest): Promise<SelectAnswer> {
		const hay = `${req.title ?? ""} ${req.message ?? ""}`.toLowerCase();
		let choice: string | undefined;
		for (const rule of this.rules) {
			if (!hay.includes(rule.match.toLowerCase())) continue;
			choice = rule.prefer.find((p) =>
				req.options.some((o) => o.toLowerCase().includes(p.toLowerCase())),
			);
			if (choice) {
				// Return the actual offered option string, not the rule fragment.
				choice = req.options.find((o) =>
					o.toLowerCase().includes(choice as string),
				);
				break;
			}
		}
		const value = choice ?? req.options[0];
		const answer: SelectAnswer = { value };
		this.onDialog?.(req, answer);
		return answer;
	}

	async confirm(req: UiConfirmRequest): Promise<ConfirmAnswer> {
		const answer: ConfirmAnswer = { confirmed: this.confirmDefault };
		this.onDialog?.(req, answer);
		return answer;
	}

	async input(req: UiInputRequest): Promise<TextAnswer> {
		const answer: TextAnswer = { value: this.textDefault };
		this.onDialog?.(req, answer);
		return answer;
	}

	async editor(req: UiEditorRequest): Promise<TextAnswer> {
		const answer: TextAnswer = { value: req.prefill ?? this.textDefault };
		this.onDialog?.(req, answer);
		return answer;
	}
}

/** Default rules: advance the plan→execution transition and keep going. */
export const DEFAULT_SELECT_RULES: SelectRule[] = [
	{ match: "execution", prefer: ["enter execution", "enter", "execute"] },
	{ match: "plan", prefer: ["enter execution", "proceed", "continue"] },
	{ match: "ship", prefer: ["ship", "yes", "proceed"] },
	{ match: "review", prefer: ["accept", "proceed", "continue"] },
];

// --- ForwardingAnswerer ----------------------------------------------------

/** A dialog parked awaiting an out-of-process answer. */
export interface PendingDialog {
	readonly id: string;
	readonly method: UiDialogRequest["method"];
	readonly title?: string;
	readonly message?: string;
	readonly options?: string[];
}

/**
 * Parks each dialog and resolves it only when an external caller supplies the
 * answer (via `resolve`). The LLM-driver daemon exposes the parked dialogs
 * through its `poll` command and feeds answers back through `answer`.
 */
export class ForwardingAnswerer implements Answerer {
	private readonly waiters = new Map<
		string,
		{
			resolve: (payload: Record<string, unknown>) => void;
			req: UiDialogRequest;
		}
	>();

	/** Dialogs currently awaiting an answer, in arrival order. */
	pending(): PendingDialog[] {
		return [...this.waiters.values()].map(({ req }) => ({
			id: req.id,
			method: req.method,
			title: (req as UiSelectRequest).title,
			message: (req as UiSelectRequest).message,
			options: (req as UiSelectRequest).options,
		}));
	}

	/**
	 * Resolve a parked dialog. `raw` is the caller's answer: for a select it is
	 * the chosen option string, for a confirm "true"/"false", for input/editor
	 * the text. Returns false if no dialog with that id is waiting.
	 */
	resolve(id: string, raw: string): boolean {
		const waiter = this.waiters.get(id);
		if (!waiter) return false;
		this.waiters.delete(id);
		waiter.resolve(this.payloadFor(waiter.req, raw));
		return true;
	}

	private payloadFor(
		req: UiDialogRequest,
		raw: string,
	): Record<string, unknown> {
		if (req.method === "confirm") {
			return { confirmed: raw === "true" || raw === "yes" || raw === "y" };
		}
		return { value: raw };
	}

	private park<T>(req: UiDialogRequest): Promise<T> {
		return new Promise<T>((resolve) => {
			this.waiters.set(req.id, {
				req,
				resolve: resolve as (payload: Record<string, unknown>) => void,
			});
		});
	}

	select(req: UiSelectRequest): Promise<SelectAnswer> {
		return this.park<SelectAnswer>(req);
	}
	confirm(req: UiConfirmRequest): Promise<ConfirmAnswer> {
		return this.park<ConfirmAnswer>(req);
	}
	input(req: UiInputRequest): Promise<TextAnswer> {
		return this.park<TextAnswer>(req);
	}
	editor(req: UiEditorRequest): Promise<TextAnswer> {
		return this.park<TextAnswer>(req);
	}
}

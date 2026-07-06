import type { Answers, Question, QuestionOption } from "@vegardx/pi-contracts";
import type { PendingQuestion } from "./question-queue.js";

/**
 * Structured picker overlay for answering agent questions.
 * Shows one question at a time with selectable options.
 * Used for both explicit escalation and timeout fallback.
 */
export class QuestionPickerComponent {
	private questionIdx = 0;
	private selections: Map<string, string> = new Map();
	private cursorIdx = 0;

	constructor(
		private readonly entry: PendingQuestion,
		private readonly done: (answers: Answers | undefined) => void,
		private readonly palette: PickerPalette,
	) {
		// Pre-select recommendations
		for (const q of entry.questions) {
			if (q.recommendation) {
				this.selections.set(q.id, q.recommendation);
			}
		}
	}

	private get currentQuestion(): Question {
		return this.entry.questions[this.questionIdx];
	}

	private get options(): readonly QuestionOption[] {
		return this.currentQuestion.options ?? [];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const maxW = Math.min(width, 72);
		const lines: string[] = [];
		const q = this.currentQuestion;
		const total = this.entry.questions.length;

		// Header
		const header = total > 1
			? `─ ${this.entry.agentName} — Question ${this.questionIdx + 1}/${total} ─`
			: `─ ${this.entry.agentName} ─`;
		lines.push(this.palette.heading(header));
		lines.push("");

		// Question text
		const wrapped = wrapText(q.question, maxW - 2);
		for (const line of wrapped) {
			lines.push(`  ${line}`);
		}
		lines.push("");

		// Context
		if (q.context) {
			const ctxLines = wrapText(q.context, maxW - 4);
			for (const line of ctxLines) {
				lines.push(`  ${this.palette.dim(line)}`);
			}
			lines.push("");
		}

		// Options
		const selected = this.selections.get(q.id);
		for (let i = 0; i < this.options.length; i++) {
			const opt = this.options[i];
			const value = opt.value ?? opt.label;
			const isSelected = selected === value;
			const isCursor = i === this.cursorIdx;
			const letter = String.fromCharCode(65 + i);
			const bullet = isSelected ? "●" : "○";
			const rec = value === q.recommendation ? ` ${this.palette.accent("[rec]")}` : "";

			let line = `  ${isCursor ? "›" : " "} ${bullet} ${letter}) ${opt.label}${rec}`;
			if (isCursor) line = this.palette.accent(line);
			else if (isSelected) line = this.palette.heading(line);
			lines.push(line);

			if (opt.description) {
				const desc = `      ${opt.description}`;
				lines.push(isCursor ? this.palette.accent(desc) : this.palette.dim(desc));
			}
		}

		lines.push("");

		// Footer
		const footerParts: string[] = [];
		footerParts.push("[Enter] confirm");
		if (total > 1) {
			if (this.questionIdx < total - 1) footerParts.push("[→/Tab] next");
			if (this.questionIdx > 0) footerParts.push("[←/S-Tab] prev");
		}
		footerParts.push("[q] skip");
		lines.push(`  ${this.palette.dim(footerParts.join("  "))}`);

		return lines;
	}

	handleInput(data: string): void {
		const opts = this.options;
		switch (data) {
			case "\x1b[A": // up
			case "k":
				if (this.cursorIdx > 0) this.cursorIdx--;
				break;
			case "\x1b[B": // down
			case "j":
				if (this.cursorIdx < opts.length - 1) this.cursorIdx++;
				break;
			case " ": // space selects
			case "\r": { // enter confirms
				if (opts.length > 0) {
					const opt = opts[this.cursorIdx];
					this.selections.set(
						this.currentQuestion.id,
						opt.value ?? opt.label,
					);
				}
				if (data === "\r") {
					this.advanceOrFinish();
				}
				break;
			}
			case "\x1b[C": // right
			case "\t": // tab
				this.nextQuestion();
				break;
			case "\x1b[D": // left
			case "\x1b[Z": // shift-tab
				this.prevQuestion();
				break;
			case "q":
			case "\x1b": // escape
				this.done(undefined);
				break;
			default:
				// Letter shortcut (a-z)
				if (data.length === 1 && data >= "a" && data <= "z") {
					const idx = data.charCodeAt(0) - 97; // a=0, b=1, ...
					if (idx < opts.length) {
						this.cursorIdx = idx;
						const opt = opts[idx];
						this.selections.set(
							this.currentQuestion.id,
							opt.value ?? opt.label,
						);
					}
				}
				break;
		}
	}

	private nextQuestion(): void {
		if (this.questionIdx < this.entry.questions.length - 1) {
			this.questionIdx++;
			this.cursorIdx = 0;
		}
	}

	private prevQuestion(): void {
		if (this.questionIdx > 0) {
			this.questionIdx--;
			this.cursorIdx = 0;
		}
	}

	private advanceOrFinish(): void {
		if (this.questionIdx < this.entry.questions.length - 1) {
			this.nextQuestion();
			return;
		}
		// All questions answered — collect results
		const answers: Answers = this.entry.questions.map((q) => ({
			questionId: q.id,
			value: this.selections.get(q.id) ?? "",
		}));
		this.done(answers);
	}
}

export interface PickerPalette {
	dim: (s: string) => string;
	accent: (s: string) => string;
	heading: (s: string) => string;
}

function wrapText(text: string, maxWidth: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length + word.length + 1 > maxWidth && current.length > 0) {
			lines.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

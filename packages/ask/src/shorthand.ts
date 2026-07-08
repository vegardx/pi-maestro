// Shorthand replies: `rec`, `2`, `b`, `1a 2b`, optionally followed by free
// text (`2 but use WAL`). Parsed against either the pending widget set or a
// decision block the assistant printed in chat. Pure functions — the
// extension wires them to pi's input-transform hook.

import type { Answer, Question } from "@vegardx/pi-contracts";

export interface ShorthandMatch {
	readonly answers: readonly Answer[];
	/** Free text following the shorthand tokens, if any. */
	readonly trailer?: string;
	/** Human-readable expansion, for transcript-explicit transforms. */
	readonly expansion: string;
}

/** A decision point shorthand can resolve against. */
export interface DecisionPoint {
	readonly id: string;
	readonly title: string;
	readonly options: readonly string[];
	/** Index into options, when the asker recommended one. */
	readonly recommended?: number;
}

export function questionToDecisionPoint(q: Question): DecisionPoint {
	const options = (q.options ?? []).map((o) => o.value ?? o.label);
	const recIdx = q.recommendation ? options.indexOf(q.recommendation) : -1;
	return {
		id: q.id,
		title: q.question,
		options,
		...(recIdx >= 0 ? { recommended: recIdx } : {}),
	};
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Parse a shorthand reply against ordered decision points. Returns undefined
 * when the text is not shorthand (it should reach the model untouched).
 *
 * Grammar (first token must parse, later tokens greedily, rest is trailer):
 *   rec                   → the recommended option of every point that has one
 *   <n>   (single point)  → option n (1-based)
 *   <letter> (single)     → option by letter
 *   <q><letter> tokens    → per-question picks, e.g. `1a 2b`
 */
export function parseShorthand(
	text: string,
	points: readonly DecisionPoint[],
): ShorthandMatch | undefined {
	if (points.length === 0) return undefined;
	const trimmed = text.trim();
	if (trimmed === "" || trimmed.length > 200) return undefined;
	const words = trimmed.split(/\s+/);

	const answers: Answer[] = [];
	const picks: string[] = [];
	let consumed = 0;

	const pick = (point: DecisionPoint, optIdx: number): boolean => {
		if (optIdx < 0 || optIdx >= point.options.length) return false;
		if (answers.some((a) => a.questionId === point.id)) return false;
		answers.push({ questionId: point.id, value: point.options[optIdx] });
		picks.push(`${point.title} → ${point.options[optIdx]}`);
		return true;
	};

	if (words[0].toLowerCase() === "rec") {
		let any = false;
		for (const point of points) {
			if (point.recommended !== undefined && pick(point, point.recommended)) {
				any = true;
			}
		}
		if (!any) return undefined;
		consumed = 1;
	} else {
		for (const word of words) {
			const token = word.toLowerCase();
			let ok = false;
			if (points.length === 1) {
				// Single decision: a bare number or letter picks the option.
				if (/^\d$/.test(token)) {
					ok = pick(points[0], Number.parseInt(token, 10) - 1);
				} else if (/^[a-z]$/.test(token)) {
					ok = pick(points[0], LETTERS.indexOf(token));
				}
			}
			if (!ok && /^\d[a-z]$/.test(token)) {
				const qIdx = Number.parseInt(token[0], 10) - 1;
				const point = points[qIdx];
				if (point) ok = pick(point, LETTERS.indexOf(token[1]));
			}
			if (!ok) break;
			consumed++;
		}
		if (consumed === 0) return undefined;
	}

	const trailer = words.slice(consumed).join(" ") || undefined;
	// A trailing remark is fine; a long essay after one token usually means
	// the token match was accidental ("2 hours later everything broke...").
	if (trailer && consumed === 1 && words.length > 8) return undefined;
	const expansion =
		`Decisions: ${picks.map((p, i) => `(${i + 1}) ${p}`).join("; ")}.` +
		(trailer ? ` ${trailer}` : "");
	return { answers, trailer, expansion };
}

// ─── Decision blocks in chat text ────────────────────────────────────────────

/**
 * Parse the `◆` decision block out of an assistant message, if present.
 * Strict shape (the preamble mandates it):
 *
 *   ◆ <heading>
 *     1. <question title>
 *        a. <option label> — <tradeoff>   ← rec
 *        b. <option label>
 *     2. ...
 *
 * Returns the ordered decision points, or [] when there is no block.
 */
export function parseDecisionBlock(text: string): DecisionPoint[] {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.trimStart().startsWith("◆"));
	if (start < 0) return [];

	const points: DecisionPoint[] = [];
	let current:
		| { title: string; options: string[]; recommended?: number }
		| undefined;
	const flush = () => {
		if (current && current.options.length > 0) {
			points.push({
				id: `dp-${points.length + 1}`,
				title: current.title,
				options: current.options,
				...(current.recommended !== undefined
					? { recommended: current.recommended }
					: {}),
			});
		}
		current = undefined;
	};

	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		// A blank line after options ends the block only when a non-indented
		// paragraph follows; keep it simple: stop at the reply-syntax coda or
		// a heading-like line.
		const qMatch = line.match(/^\s{0,4}(\d+)\.\s+(.+)$/);
		const oMatch = line.match(/^\s{2,}([a-z])\.\s+(.+)$/);
		if (oMatch && current) {
			const rest = oMatch[2];
			const rec = /(?:←|<-)\s*rec/i.test(rest);
			// Label = text up to a separator (— or ;) or the rec marker.
			const label = rest
				.replace(/\s*(?:←|<-)\s*rec.*$/i, "")
				.split(/\s+—\s+/)[0]
				.trim();
			if (LETTERS[current.options.length] === oMatch[1]) {
				current.options.push(label);
				if (rec) current.recommended = current.options.length - 1;
			}
			continue;
		}
		if (qMatch) {
			flush();
			current = { title: qMatch[2].trim(), options: [] };
		}
	}
	flush();
	return points;
}

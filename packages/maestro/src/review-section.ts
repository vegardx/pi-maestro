// The Review section: what reviewed a deliverable, what they found, and what
// the implementer answered — rendered ONCE, read in three places.
//
// pi-workflow 5 records each reviewed deliverable as `reviews-<d>`: every
// reviewer (lens, model, thinking, attempt, whether it reported), every cluster
// of findings with who reported it and how many agreed, and the resumed
// implementer's disposition for each — `fixed`, `declined` with its reasoning,
// or `out-of-scope`. The harness wrote all of that attribution, never a model.
//
// THREE SURFACES, ONE FUNCTION. The ship dialog's *Look first*, the account an
// `auto` run posts after it publishes, and the pull request's body all show the
// same section, rendered by `renderReviewSections` from the same two values per
// deliverable (the record and the last check report). A person comparing what
// they were asked about with what was published is comparing one text, not three
// formats that drifted.
//
// BOUNDED, AND IT SAYS SO. A record holds up to 1024 clusters with 2 KiB of
// reasoning each, and a pull-request body has a hard size limit. So clusters,
// claims, reasoning and reporters are capped, the section says how many were
// left out, and it names where the whole record is: the run's receipt.
//
// NOTHING HERE IMPORTS pi-workflow. It is an optional peer, so the record is
// read tolerantly from `unknown` — the same discipline `decide.ts` keeps — into
// this module's own view, and an entry that does not read is counted rather
// than silently dropped.

/** The dispositions a resumed implementer answers with, in pi-workflow's words. */
export const DISPOSITION_KINDS = ["fixed", "declined", "out-of-scope"] as const;

export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/** A cluster's severity: the highest any of its reporters gave. */
export const REVIEW_SEVERITIES = ["high", "medium", "low"] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** Most clusters one deliverable's section lists before it counts the rest. */
export const MAX_SECTION_CLUSTERS = 10;

/**
 * Most clusters every section of one rendering lists together.
 *
 * Shared out across deliverables (never below `MIN_SECTION_CLUSTERS` each), so a
 * sixteen-deliverable run still fits a pull-request body.
 */
export const MAX_TOTAL_CLUSTERS = 40;

export const MIN_SECTION_CLUSTERS = 2;

/** A claim is cut here; the record carries it whole. */
export const MAX_RENDERED_CLAIM = 200;

/** A disposition's reasoning is cut here; the record carries it whole. */
export const MAX_RENDERED_REASONING = 280;

/** Reporters named on one cluster before the rest are counted. */
export const MAX_RENDERED_REPORTERS = 4;

/**
 * The longest rendering, in characters. GitHub refuses a pull-request body over
 * 65,536 characters; the body carries the handoffs and the check besides this.
 */
export const MAX_SECTIONS_LENGTH = 48_000;

export interface ReviewerView {
	readonly lens: string;
	readonly model: string;
	readonly thinking?: string;
	readonly status: "reported" | "failed";
	readonly findings: number;
}

export interface ReporterView {
	readonly lens: string;
	readonly model: string;
	readonly thinking?: string;
}

export interface ClusterView {
	readonly id: string;
	readonly claim: string;
	readonly file: string;
	readonly line?: number;
	readonly severity: ReviewSeverity;
	readonly reportedBy: readonly ReporterView[];
	readonly agreement: { readonly count: number; readonly of: number };
	readonly disposition?: {
		readonly kind: DispositionKind;
		readonly reasoning: string;
	};
}

/** One `reviews-<d>` record, as this seat reads it. */
export interface ReviewsView {
	readonly deliverable: string;
	readonly reviewers: readonly ReviewerView[];
	readonly clusters: readonly ClusterView[];
	/** Reviewer and cluster entries that did not read; said, never hidden. */
	readonly unreadable: number;
}

/** The last check over a deliverable's hand-off. */
export interface CheckView {
	readonly command?: string;
	readonly ran: boolean;
	readonly passed: boolean;
}

/** What one deliverable's section is rendered from. */
export interface ReviewSectionInput {
	readonly id: string;
	/** Absent when the deliverable listed no reviews. */
	readonly reviews?: ReviewsView;
	readonly check?: CheckView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

function oneOf<T extends string>(
	values: readonly T[],
	value: unknown,
): T | undefined {
	return (values as readonly unknown[]).includes(value)
		? (value as T)
		: undefined;
}

function readReviewer(value: unknown): ReviewerView | undefined {
	if (!isRecord(value)) return undefined;
	const lens = text(value.lens);
	const model = text(value.model);
	const status = oneOf(["reported", "failed"] as const, value.status);
	const findings = count(value.findings);
	if (!lens || !model || !status || findings === undefined) return undefined;
	const thinking = text(value.thinking);
	return { lens, model, ...(thinking ? { thinking } : {}), status, findings };
}

function readReporter(value: unknown): ReporterView | undefined {
	if (!isRecord(value)) return undefined;
	const lens = text(value.lens);
	const model = text(value.model);
	if (!lens || !model) return undefined;
	const thinking = text(value.thinking);
	return { lens, model, ...(thinking ? { thinking } : {}) };
}

function readCluster(value: unknown): ClusterView | undefined {
	if (!isRecord(value)) return undefined;
	const id = text(value.id);
	const claim = text(value.claim);
	const location = isRecord(value.location) ? value.location : undefined;
	const file = text(location?.file);
	const line = count(location?.line);
	const severity = oneOf(REVIEW_SEVERITIES, value.severity);
	const agreement = isRecord(value.agreement) ? value.agreement : undefined;
	const agreed = count(agreement?.count);
	const of = count(agreement?.of);
	const reporters = Array.isArray(value.reportedBy)
		? value.reportedBy.map(readReporter)
		: [];
	if (
		!id ||
		!claim ||
		!file ||
		!severity ||
		agreed === undefined ||
		of === undefined ||
		reporters.length === 0 ||
		reporters.some((reporter) => reporter === undefined)
	)
		return undefined;
	const disposition = isRecord(value.disposition)
		? value.disposition
		: undefined;
	const kind = oneOf(DISPOSITION_KINDS, disposition?.kind);
	const reasoning = text(disposition?.reasoning);
	return {
		id,
		claim,
		file,
		...(line !== undefined && line > 0 ? { line } : {}),
		severity,
		reportedBy: reporters as ReporterView[],
		agreement: { count: agreed, of },
		...(kind && reasoning ? { disposition: { kind, reasoning } } : {}),
	};
}

/**
 * A `reviews-<d>` record, or nothing when the value is not one at all.
 *
 * A record with a deliverable id and both lists is read; an entry inside it
 * that does not read is counted in `unreadable`, because a section that dropped
 * a finding without saying so is worse than one that admits it could not read
 * it.
 */
export function readReviewsRecord(value: unknown): ReviewsView | undefined {
	if (!isRecord(value)) return undefined;
	const deliverable = text(value.deliverable);
	if (
		!deliverable ||
		!Array.isArray(value.reviewers) ||
		!Array.isArray(value.clusters)
	)
		return undefined;
	const reviewers = value.reviewers.map(readReviewer);
	const clusters = value.clusters.map(readCluster);
	const unreadable =
		reviewers.filter((entry) => entry === undefined).length +
		clusters.filter((entry) => entry === undefined).length;
	return {
		deliverable,
		reviewers: reviewers.filter(
			(entry): entry is ReviewerView => entry !== undefined,
		),
		clusters: clusters.filter(
			(entry): entry is ClusterView => entry !== undefined,
		),
		unreadable,
	};
}

/**
 * A check report — pi-workflow's `CheckReportSchema`, or the `checkRan` /
 * `checkPassed` pair a run's output carries per deliverable — or nothing.
 */
export function readCheckReport(value: unknown): CheckView | undefined {
	if (!isRecord(value) || typeof value.checkRan !== "boolean") return undefined;
	const command = text(value.checkCommand);
	return {
		...(command ? { command } : {}),
		ran: value.checkRan,
		passed: value.checkRan && value.checkPassed === true,
	};
}

/** What a gate and a receipt say about one record: counts, never prose. */
export interface ReviewTally {
	readonly reviewers: number;
	readonly reported: number;
	readonly clusters: number;
	/** Clusters two or more reviewers raised. */
	readonly agreed: number;
	readonly fixed: number;
	readonly declined: number;
	readonly outOfScope: number;
	/** No disposition: no resume ran, or it was refused. */
	readonly unanswered: number;
}

export function tallyReviews(reviews: ReviewsView): ReviewTally {
	const answered = (kind: DispositionKind) =>
		reviews.clusters.filter((cluster) => cluster.disposition?.kind === kind)
			.length;
	return {
		reviewers: reviews.reviewers.length,
		reported: reviews.reviewers.filter((entry) => entry.status === "reported")
			.length,
		clusters: reviews.clusters.length,
		agreed: reviews.clusters.filter((cluster) => cluster.agreement.count >= 2)
			.length,
		fixed: answered("fixed"),
		declined: answered("declined"),
		outOfScope: answered("out-of-scope"),
		unanswered: reviews.clusters.filter(
			(cluster) => cluster.disposition === undefined,
		).length,
	};
}

/** Every tally of a rendering, summed. */
export function sumTallies(tallies: readonly ReviewTally[]): ReviewTally {
	const sum = (field: keyof ReviewTally) =>
		tallies.reduce((total, tally) => total + tally[field], 0);
	return {
		reviewers: sum("reviewers"),
		reported: sum("reported"),
		clusters: sum("clusters"),
		agreed: sum("agreed"),
		fixed: sum("fixed"),
		declined: sum("declined"),
		outOfScope: sum("outOfScope"),
		unanswered: sum("unanswered"),
	};
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The dispositions, in one clause: `1 fixed, 1 declined, …`. */
export function dispositionCounts(tally: ReviewTally): string {
	return (
		`${tally.fixed} fixed, ${tally.declined} declined, ` +
		`${tally.outOfScope} out of scope, ${tally.unanswered} unanswered`
	);
}

/** Who reviewed, what they raised, and how it was answered, in one sentence. */
export function tallyLine(tally: ReviewTally): string {
	return (
		`${tally.reported} of ${plural(tally.reviewers, "reviewer")} reported; ` +
		`${plural(tally.clusters, "finding")}, ${tally.agreed} raised by two or more; ` +
		`${dispositionCounts(tally)}`
	);
}

/** The last check, in one sentence. */
export function checkLine(check: CheckView | undefined): string {
	if (!check) return "Check: no report.";
	const command = check.command ? `\`${check.command}\` ` : "";
	if (!check.ran) return `Check: ${command}did not run.`;
	return `Check: ${command}ran and ${check.passed ? "passed" : "failed"}.`;
}

function cut(value: string, max: number): string {
	const line = value.replace(/\s+/gu, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function who(entry: {
	readonly lens: string;
	readonly model: string;
	readonly thinking?: string;
}): string {
	return `${entry.lens} (${entry.model}${entry.thinking ? `, ${entry.thinking}` : ""})`;
}

/** Declined first, then unanswered, out of scope, fixed; worst first within. */
const ORDER: readonly (DispositionKind | "unanswered")[] = [
	"declined",
	"unanswered",
	"out-of-scope",
	"fixed",
];

function rank(cluster: ClusterView): number {
	return (
		ORDER.indexOf(cluster.disposition?.kind ?? "unanswered") * 10 +
		REVIEW_SEVERITIES.indexOf(cluster.severity)
	);
}

/** One cluster: claim — where · found by whom ×agreement · severity · answer. */
export function renderCluster(cluster: ClusterView): string {
	const where = `${cluster.file}${cluster.line !== undefined ? `:${cluster.line}` : ""}`;
	const shown = cluster.reportedBy.slice(0, MAX_RENDERED_REPORTERS).map(who);
	const more = cluster.reportedBy.length - shown.length;
	const by = `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
	const answer = cluster.disposition
		? `${cluster.disposition.kind} (${cut(cluster.disposition.reasoning, MAX_RENDERED_REASONING)})`
		: "unanswered";
	return (
		`- ${cut(cluster.claim, MAX_RENDERED_CLAIM)} — ${where}` +
		` · found by ${by} ×${cluster.agreement.count} of ${cluster.agreement.of}` +
		` · ${cluster.severity} · ${answer}`
	);
}

/** One deliverable's section, listing at most `limit` clusters. */
export function renderReviewSection(
	input: ReviewSectionInput,
	limit: number = MAX_SECTION_CLUSTERS,
): string {
	const lines: string[] = [];
	const reviews = input.reviews;
	if (!reviews) {
		lines.push(`Review of \`${input.id}\`: no reviewers were asked.`);
		lines.push(checkLine(input.check));
		return lines.join("\n");
	}
	const tally = tallyReviews(reviews);
	lines.push(`Review of \`${input.id}\`: ${tallyLine(tally)}.`);
	lines.push(checkLine(input.check));
	const declined = reviews.clusters.filter(
		(cluster) => cluster.disposition?.kind === "declined",
	);
	if (declined.length > 0)
		lines.push(
			`Declined, shipping as it is: ${declined.map((cluster) => cluster.id).join(", ")}.`,
		);
	const failed = reviews.reviewers.filter((entry) => entry.status === "failed");
	if (failed.length > 0)
		lines.push(
			`Did not report, so not counted in any agreement: ${failed.map(who).join(", ")}.`,
		);
	const ordered = reviews.clusters
		.map((cluster, index) => ({ cluster, index }))
		.sort(
			(left, right) =>
				rank(left.cluster) - rank(right.cluster) || left.index - right.index,
		)
		.map((entry) => entry.cluster);
	const shown = ordered.slice(0, Math.max(0, limit));
	for (const cluster of shown)
		lines.push(`${renderCluster(cluster)} [${cluster.id}]`);
	const omitted = ordered.length - shown.length;
	if (omitted > 0)
		lines.push(
			`${plural(omitted, "more finding")} not shown; the full record is in the run's receipt (\`reviews-${reviews.deliverable}\`).`,
		);
	if (reviews.unreadable > 0)
		lines.push(
			`${plural(reviews.unreadable, "entry", "entries")} of the record could not be read here; the receipt has them.`,
		);
	return lines.join("\n");
}

/**
 * Every deliverable's section, in order, bounded as a whole.
 *
 * THE ONE RENDERING the three surfaces share. Clusters are shared out across
 * deliverables, and a rendering that would still run past
 * `MAX_SECTIONS_LENGTH` gives its remaining deliverables their summary line
 * alone rather than being cut mid-sentence.
 */
export function renderReviewSections(
	inputs: readonly ReviewSectionInput[],
): string {
	if (inputs.length === 0) return "";
	const perSection = Math.min(
		MAX_SECTION_CLUSTERS,
		Math.max(
			MIN_SECTION_CLUSTERS,
			Math.floor(MAX_TOTAL_CLUSTERS / inputs.length),
		),
	);
	const sections: string[] = [];
	let length = 0;
	for (const input of inputs) {
		let section = renderReviewSection(input, perSection);
		if (length + section.length + 2 > MAX_SECTIONS_LENGTH)
			section = renderReviewSection(input, 0);
		sections.push(section);
		length += section.length + 2;
	}
	return sections.join("\n\n");
}

// ── Where the two values come from ───────────────────────────────────────────

function at(value: unknown, ...path: readonly string[]): unknown {
	let current: unknown = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

/** The `ship` checkpoint's verified inputs, when the inspection carries them. */
function shipInputs(inspection: unknown): Record<string, unknown> | undefined {
	const tasks = at(inspection, "tasks") ?? at(inspection, "run", "tasks");
	if (!Array.isArray(tasks)) return undefined;
	const ship = tasks.find(
		(task) => at(task, "kind") === "checkpoint" && at(task, "key") === "ship",
	);
	const inputs = at(ship, "checkpoint", "inputs");
	return isRecord(inputs) ? inputs : undefined;
}

/**
 * The sections a gate's own inputs describe: `reviews-<d>` and `check-<d>` per
 * deliverable, named by every `summary-`, `reviews-` and `check-` input so a
 * deliverable whose implementer reported nothing is not the one that is lost.
 */
export function sectionsFromGateInputs(
	inputs: Readonly<Record<string, unknown>>,
): readonly ReviewSectionInput[] {
	const ids: string[] = [];
	for (const name of Object.keys(inputs))
		for (const prefix of ["summary-", "reviews-", "check-"])
			if (name.startsWith(prefix)) {
				const id = name.slice(prefix.length);
				if (id.length > 0 && !ids.includes(id)) ids.push(id);
			}
	return ids.map((id) => {
		const reviews = readReviewsRecord(inputs[`reviews-${id}`]);
		const check = readCheckReport(inputs[`check-${id}`]);
		return { id, ...(reviews ? { reviews } : {}), ...(check ? { check } : {}) };
	});
}

/** `shipSummary.deliverables[]`: the same three values under their own names. */
export function sectionsFromShipSummary(
	summary: unknown,
): readonly ReviewSectionInput[] {
	const entries = at(summary, "deliverables");
	if (!Array.isArray(entries)) return [];
	const sections: ReviewSectionInput[] = [];
	for (const entry of entries) {
		const id = text(at(entry, "id"));
		if (!id) continue;
		const reviews = readReviewsRecord(at(entry, "reviews"));
		const check = readCheckReport(at(entry, "check"));
		sections.push({
			id,
			...(reviews ? { reviews } : {}),
			...(check ? { check } : {}),
		});
	}
	return sections;
}

/**
 * The sections a run inspection describes, from the best source it carries.
 *
 * The `ship` checkpoint's inputs first — what a gated run's person was shown —
 * then `output.shipSummary`, which is what a `gates: "none"` run carries in
 * their place, and last the terminal output's `reviews[]` beside each
 * deliverable's `checkRan`/`checkPassed`, which every completed run has.
 */
export function reviewSectionsFrom(
	inspection: unknown,
): readonly ReviewSectionInput[] {
	const inputs = shipInputs(inspection);
	if (inputs) {
		const sections = sectionsFromGateInputs(inputs);
		if (sections.length > 0) return sections;
	}
	const output = at(inspection, "run", "output") ?? at(inspection, "output");
	const fromSummary = sectionsFromShipSummary(at(output, "shipSummary"));
	if (fromSummary.length > 0) return fromSummary;
	const records = at(output, "reviews");
	const byId = new Map<string, ReviewsView>();
	for (const record of Array.isArray(records) ? records : []) {
		const read = readReviewsRecord(record);
		if (read) byId.set(read.deliverable, read);
	}
	const sections: ReviewSectionInput[] = [];
	const deliverables = at(output, "deliverables");
	for (const entry of Array.isArray(deliverables) ? deliverables : []) {
		const id = text(at(entry, "id"));
		if (!id) continue;
		const reviews = byId.get(id);
		const check = readCheckReport(entry);
		sections.push({
			id,
			...(reviews ? { reviews } : {}),
			...(check ? { check } : {}),
		});
	}
	return sections;
}

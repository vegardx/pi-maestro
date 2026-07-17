// The maestro triage tier: when a ship gate blocks, the maestro model — not
// the human — is the first responder. It reads the findings (and any worker
// disputes) and either sends the deliverable back with concrete guidance
// (budget: once per deliverable) or escalates to the human with a MANDATORY
// recommendation. The human is the final authority, never the first stop.
//
// Authority boundary, unchanged and load-bearing: the `gate` tool has NO
// override/waive action. However convinced the maestro becomes, only the
// human's answer to the gate question can open the gate.

import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	buildSendBackKickoff,
	type GateDecisionDeps,
	presentGateDecision,
	renderFindings,
} from "./gate-decision.js";

/** How long the maestro gets to triage before the question falls through. */
const TRIAGE_TIMEOUT_MS = 10 * 60_000;

interface TriageRecord {
	sendBacksUsed: number;
	escalated: boolean;
	pending?: {
		reason: string;
		timer: ReturnType<typeof setTimeout>;
	};
}

export interface GateTriageDeps extends GateDecisionDeps {
	readonly timeoutMs?: number;
}

export class GateTriage {
	private records = new Map<string, TriageRecord>();

	constructor(private readonly deps: GateTriageDeps) {}

	/** Entry point for every new ship-gate block (fired once per reason). */
	handleBlock(deliverableId: string, reason: string): void {
		const rec = this.record(deliverableId);
		// The maestro already spent its guidance (or already escalated) and the
		// gate blocked again — a repeat is the human's call, with the history.
		if (rec.sendBacksUsed >= 1 || rec.escalated) {
			rec.escalated = true;
			void presentGateDecision(this.deps, deliverableId, reason, {
				banner:
					rec.sendBacksUsed >= 1
						? "The maestro already sent this back once with guidance and the gate blocked again."
						: undefined,
			});
			return;
		}
		if (rec.pending) return; // triage already in flight for this block
		const timer = setTimeout(() => {
			this.fallthrough(deliverableId, reason);
		}, this.deps.timeoutMs ?? TRIAGE_TIMEOUT_MS);
		timer.unref?.();
		rec.pending = { reason, timer };

		const execution = this.deps.execution();
		const failing = execution?.failingRequiredReviewers(deliverableId) ?? [];
		const findings = renderFindings(
			execution?.reviewerFindings(deliverableId) ?? [],
		);
		this.deps.pi.sendUserMessage(
			`[Ship gate blocked — TRIAGE THIS NOW. "${deliverableId}": ${reason}. ` +
				`Holding: ${failing.join(", ") || "required reviewers"}.` +
				(findings ? `\n\n${findings}` : "") +
				"\n\nRead both sides (worker disputes carry their rationale in the ledger). Then call the `gate` tool:\n" +
				'- gate(action: "sendback", deliverableId, guidance): the findings are actionable — put the worker back to work with CONCRETE guidance. You get ONE send-back per deliverable.\n' +
				"- gate(action: \"escalate\", deliverableId, recommendation, why, recommendedAction?): a genuine judgment call, you side with the worker, or the findings aren't the worker's to fix — escalate to the human WITH your recommendation.\n" +
				"If a finding is cross-cutting (not this worker's to fix), you still hold your plan tools: add the follow-up task/deliverable first, then escalate recommending a waiver with that as the justification. " +
				`You cannot open the gate yourself. No action within ${Math.round((this.deps.timeoutMs ?? TRIAGE_TIMEOUT_MS) / 60_000)} minutes sends the question to the human without a recommendation.]`,
			{ deliverAs: "followUp" },
		);
	}

	/** The maestro's send-back (via the gate tool). One per deliverable. */
	async sendBack(
		deliverableId: string,
		guidance: string,
	): Promise<{ ok: boolean; error?: string }> {
		const execution = this.deps.execution();
		if (!execution) return { ok: false, error: "no execution running" };
		const rec = this.record(deliverableId);
		if (rec.sendBacksUsed >= 1) {
			return {
				ok: false,
				error:
					"send-back budget spent for this deliverable — escalate to the human with your recommendation instead",
			};
		}
		if (!guidance.trim()) {
			return { ok: false, error: "guidance must not be empty" };
		}
		const reason = rec.pending?.reason ?? "ship gate blocked";
		const failing = execution.failingRequiredReviewers(deliverableId);
		const failingFindings = renderFindings(
			execution
				.reviewerFindings(deliverableId)
				.filter((f) => failing.includes(f.name)),
		);
		const kickoff = buildSendBackKickoff(
			reason,
			failing,
			guidance,
			failingFindings,
			"maestro",
		);
		const sent = await execution.sendBackToWorker(deliverableId, kickoff);
		if (!sent) {
			return {
				ok: false,
				error:
					"nothing to respawn into — escalate to the human for review or audited recovery",
			};
		}
		this.clearPending(rec);
		rec.sendBacksUsed += 1;
		this.deps.notify(
			`Maestro sent ${deliverableId} back to its worker with guidance.`,
			"info",
		);
		return { ok: true };
	}

	/** The maestro's escalation: the human decides, with a recommendation. */
	escalate(
		deliverableId: string,
		recommendation: string,
		why: string,
		recommendedAction?: "send-back" | "override" | "park",
	): { ok: boolean; error?: string } {
		const execution = this.deps.execution();
		if (!execution) return { ok: false, error: "no execution running" };
		if (!recommendation.trim() || !why.trim()) {
			return {
				ok: false,
				error:
					"recommendation and why are both required — the human never gets an undigested question",
			};
		}
		const rec = this.record(deliverableId);
		const reason = rec.pending?.reason ?? "ship gate blocked";
		this.clearPending(rec);
		rec.escalated = true;
		void presentGateDecision(this.deps, deliverableId, reason, {
			recommendation: {
				text: recommendation,
				why,
				...(recommendedAction ? { action: recommendedAction } : {}),
			},
		});
		return { ok: true };
	}

	/** Timeout: the maestro never triaged — the human still gets the question. */
	private fallthrough(deliverableId: string, reason: string): void {
		const rec = this.record(deliverableId);
		if (!rec.pending) return;
		rec.pending = undefined;
		rec.escalated = true;
		void presentGateDecision(this.deps, deliverableId, reason, {
			banner: "(no recommendation — the maestro did not triage in time)",
		});
	}

	/** Fresh episode after a human send-back re-block etc. is deliberate: NOT reset. */
	private record(deliverableId: string): TriageRecord {
		let rec = this.records.get(deliverableId);
		if (!rec) {
			rec = { sendBacksUsed: 0, escalated: false };
			this.records.set(deliverableId, rec);
		}
		return rec;
	}

	private clearPending(rec: TriageRecord): void {
		if (rec.pending) {
			clearTimeout(rec.pending.timer);
			rec.pending = undefined;
		}
	}

	destroy(): void {
		for (const rec of this.records.values()) this.clearPending(rec);
	}
}

const GateParams = Type.Object({
	action: Type.Union([Type.Literal("sendback"), Type.Literal("escalate")], {
		description:
			"sendback: put the worker back to work with guidance (once per " +
			"deliverable). escalate: hand the decision to the human with your " +
			"recommendation. There is NO override action — only the human opens " +
			"the gate.",
	}),
	deliverableId: Type.String(),
	guidance: Type.Optional(
		Type.String({
			description:
				"sendback: concrete, code-referencing guidance for the worker",
		}),
	),
	recommendation: Type.Optional(
		Type.String({
			description:
				"escalate (REQUIRED): the concrete action you would take and on what",
		}),
	),
	why: Type.Optional(
		Type.String({ description: "escalate (REQUIRED): your reasoning" }),
	),
	recommendedAction: Type.Optional(
		Type.Union(
			[
				Type.Literal("send-back"),
				Type.Literal("override"),
				Type.Literal("park"),
			],
			{
				description:
					"escalate: which gate option your recommendation maps to (it is listed first)",
			},
		),
	),
});

type GateResult = AgentToolResult<Record<string, never>>;

/** The maestro-only ship-gate triage tool. */
export function createGateTool(
	triage: () => GateTriage | undefined,
): ToolDefinition {
	return defineTool({
		name: "gate",
		label: "Gate triage",
		description:
			"Triage a blocked ship gate. sendback = respawn the worker with your " +
			"guidance (one per deliverable); escalate = ask the human, with a " +
			"REQUIRED recommendation + why. You cannot override the gate.",
		promptSnippet:
			"gate — triage a blocked ship gate (sendback with guidance, or " +
			"escalate to the human with a recommendation).",
		parameters: GateParams,
		async execute(_id, params): Promise<GateResult> {
			const t = triage();
			if (!t) {
				return textResult(
					"gate unavailable: no execution is running (start ready work with /start)",
				);
			}
			if (params.action === "sendback") {
				const result = await t.sendBack(
					params.deliverableId,
					params.guidance ?? "",
				);
				return textResult(
					result.ok
						? `Sent ${params.deliverableId} back to its worker — it reworks the findings and the gate re-evaluates. A repeat block goes to the human.`
						: `send-back failed: ${result.error}`,
				);
			}
			const result = t.escalate(
				params.deliverableId,
				params.recommendation ?? "",
				params.why ?? "",
				params.recommendedAction,
			);
			return textResult(
				result.ok
					? `Escalated ${params.deliverableId} to the human with your recommendation.`
					: `escalate failed: ${result.error}`,
			);
		},
	}) as ToolDefinition;
}

function textResult(t: string): GateResult {
	return { content: [{ type: "text", text: t }], details: {} };
}

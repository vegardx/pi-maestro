// The seat's model router, handed to pi-workflow over Pi's event bus.
//
// pi-workflow resolves every `modelRole` a task declares — a review lens's
// tier, the normalize call, the receipt recorder, the adjudicator — through ONE
// host-registered `ModelRoutingPort`, and refuses at start, by name, a workflow
// that declares `needs.modelRouting` on a host with none. `plan-to-ship`
// declares it. This file is that port, answered from `@vegardx/pi-models`'
// router over the live session.
//
// NOTHING HERE IMPORTS pi-workflow. It is an optional peer, so the channel, the
// request schema, the role and the resolution are mirrored below — the same
// bargain `workflow-provider.ts` makes for the service provider — and
// `test/workflow-routing-provider.test.ts` pins every mirrored literal against
// the value pi-workflow 8.0.0 ships, so the two cannot drift without a test
// failing.
//
// The protocol is pi-workflow's own: a request carrying `respond`, emitted and
// collected synchronously. A second registration is refused, because two
// routers would make which model a run gets depend on listener order.

import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	clampEffort,
	parseModelSpec,
	THINKING_LEVELS,
	TIER_IDS,
} from "@vegardx/pi-models";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SeatRouting } from "./model-router.js";

/** pi-workflow's `MODEL_ROUTING_REQUEST_CHANNEL`. */
export const MODEL_ROUTING_REQUEST_CHANNEL =
	"@vegardx/pi-workflow/model-routing-provider/request/v1";

/** The `schema` literal pi-workflow's routing request carries. */
export const MODEL_ROUTING_REQUEST_SCHEMA =
	"pi-workflow-model-routing-request-v1";

/** How this router names itself in a run's evidence (1..128 characters). */
export const MAESTRO_ROUTER_ID = "pi-maestro";

/** pi-workflow's `MAX_MODEL_EVIDENCE_LENGTH`: persona, family and alias. */
export const MAX_MODEL_EVIDENCE_LENGTH = 128;

/** The bound pi-workflow keeps on a resolution's `fallbackReason`. */
export const MAX_FALLBACK_REASON_LENGTH = 1024;

const literals = <T extends string>(values: readonly T[]) =>
	Type.Union(values.map((value) => Type.Literal(value)));

/**
 * pi-workflow's `ModelRoleRequest`, as a schema.
 *
 * The tier and thinking vocabularies are `@vegardx/pi-models`' own, because
 * that is the router answering; the test pins both equal to pi-workflow's
 * `MODEL_ROLE_TIERS` and `MODEL_ROLE_THINKING_LEVELS`. A role this seat cannot
 * read is refused rather than routed by a guess.
 */
export const ModelRoleRequestMirror = Type.Object({
	persona: Type.String({ minLength: 1 }),
	tier: Type.Optional(literals(TIER_IDS)),
	effort: Type.Optional(literals(THINKING_LEVELS)),
	family: Type.Optional(literals(["same", "other"] as const)),
});

export type ModelRoleRequest = {
	readonly persona: string;
	readonly tier?: (typeof TIER_IDS)[number];
	readonly effort?: (typeof THINKING_LEVELS)[number];
	readonly family?: "same" | "other";
};

/** pi-workflow's `ModelResolution`: an exact model and why it is that model. */
export interface RoutedModel {
	readonly provider: string;
	readonly id: string;
	readonly thinking: (typeof THINKING_LEVELS)[number];
	readonly source: "inherit" | "tier" | "fallback";
	readonly persona?: string;
	readonly tier?: (typeof TIER_IDS)[number];
	readonly family?: string;
	readonly alias?: string;
	readonly fallbackReason?: string;
}

/** pi-workflow's `ModelRoutingPort`, as this seat implements it. */
export interface MaestroRoutingPort {
	resolve(role: ModelRoleRequest): RoutedModel;
	authorized(model: {
		readonly provider: string;
		readonly id: string;
	}): boolean;
	readonly id: typeof MAESTRO_ROUTER_ID;
}

/**
 * Why a role could not be routed, as one sentence.
 *
 * pi-workflow replaces a foreign error's message with its own before it is
 * recorded, so this message reaches a log or a test, never a run record. It
 * still names only the persona and the tier: a router's refusal can carry the
 * models it walked, and none of that is needed to say which role went
 * unanswered.
 */
export class ModelRoutingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelRoutingError";
	}
}

/** Evidence text within a bound, or nothing for an empty value. */
function bounded(value: string | undefined, max: number): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function roleName(role: ModelRoleRequest): string {
	const persona = JSON.stringify(
		bounded(role.persona, MAX_MODEL_EVIDENCE_LENGTH),
	);
	return role.tier
		? `persona ${persona} at tier ${role.tier}`
		: `persona ${persona}`;
}

/**
 * The port, over whatever `live` answers at the moment of each call.
 *
 * THE ROUTER IS BUILT PER CALL from the live context, never captured: the seat
 * model, its thinking level and the `models` settings all move under a running
 * session. The session's model and thinking level are passed as the caller the
 * router inherits from, so a role that names no effort prefers the seat's — on
 * a tier pick that preference is clamped to the alias and the model, and on an
 * inherit or a fallback it IS the thinking level. Whatever the router answers
 * is clamped once more to the levels Pi runs the resolved model at, because the
 * admission provider beside this one refuses any other, and a routed model
 * refused by its own seat would fail every task routed to it.
 */
export function createMaestroRoutingPort(
	live: () => SeatRouting | undefined,
): MaestroRoutingPort {
	const routing = (): SeatRouting | undefined => {
		try {
			return live();
		} catch {
			// A replaced session throws from its own context: no routing.
			return undefined;
		}
	};
	return Object.freeze({
		id: MAESTRO_ROUTER_ID,
		resolve(role: ModelRoleRequest): RoutedModel {
			if (!Value.Check(ModelRoleRequestMirror, role))
				throw new ModelRoutingError(
					"pi-maestro's router was asked for a model role it cannot read",
				);
			const seat = routing();
			if (!seat)
				throw new ModelRoutingError(
					`pi-maestro has no live session to route ${roleName(role)} with`,
				);
			const resolution = seat.router.resolveForRole(role.persona, {
				...(role.tier ? { tier: role.tier } : {}),
				...(role.effort ? { effort: role.effort } : {}),
				...(role.family ? { family: role.family } : {}),
				...(seat.seat ? { inherit: seat.seat } : {}),
			});
			if (!resolution)
				throw new ModelRoutingError(
					`pi-maestro's router has no model for ${roleName(role)}: the tier is outside the persona's allowance, no roster is configured, or there is no session model to fall back to`,
				);
			const parsed = parseModelSpec(resolution.modelId);
			if (!parsed)
				throw new ModelRoutingError(
					`pi-maestro's router answered ${roleName(role)} with a model that is not a provider/model id`,
				);
			const wanted = resolution.effort ?? seat.seat?.effort ?? "medium";
			const model = seat.catalog.findModel(parsed.provider, parsed.modelId);
			const thinking = model
				? (clampEffort(wanted, {}, model) ?? wanted)
				: wanted;
			const persona = bounded(role.persona, MAX_MODEL_EVIDENCE_LENGTH);
			const family = bounded(resolution.family, MAX_MODEL_EVIDENCE_LENGTH);
			const alias = bounded(resolution.alias, MAX_MODEL_EVIDENCE_LENGTH);
			const fallbackReason = bounded(
				resolution.fallbackReason,
				MAX_FALLBACK_REASON_LENGTH,
			);
			return {
				provider: parsed.provider,
				id: parsed.modelId,
				thinking,
				source: resolution.source,
				...(persona ? { persona } : {}),
				// The tier the router reached: the one asked on a tier pick, and
				// absent when an `other`-family request degraded to the seat.
				...(resolution.tier ? { tier: resolution.tier } : {}),
				...(family ? { family } : {}),
				...(alias ? { alias } : {}),
				...(fallbackReason ? { fallbackReason } : {}),
			};
		},
		authorized(model: { readonly provider: string; readonly id: string }) {
			try {
				return (
					routing()?.router.isAuthorized(`${model.provider}/${model.id}`) ===
					true
				);
			} catch {
				return false;
			}
		},
	});
}

/** pi-workflow's routing request, recognised structurally: it carries a function. */
function isRoutingRequest(
	value: unknown,
): value is { respond(port: MaestroRoutingPort | undefined): void } {
	if (typeof value !== "object" || value === null) return false;
	const request = value as { schema?: unknown; respond?: unknown };
	return (
		request.schema === MODEL_ROUTING_REQUEST_SCHEMA &&
		typeof request.respond === "function"
	);
}

/** How many routers already answer on the channel. */
function registeredRouters(events: EventBus): number {
	let answers = 0;
	events.emit(MODEL_ROUTING_REQUEST_CHANNEL, {
		schema: MODEL_ROUTING_REQUEST_SCHEMA,
		respond() {
			answers++;
		},
	});
	return answers;
}

/** The refusal a second router meets, in pi-workflow's own words. */
export const DUPLICATE_ROUTER_REFUSAL =
	"A pi-workflow model routing provider is already registered.";

/**
 * Register this seat's router with pi-workflow, once, for the process.
 *
 * The same discipline as the subagent providers: a refusal is returned, never
 * thrown, because a seat whose runs route through somebody else's router is a
 * fact worth reporting and not a reason to fail to load.
 */
export function registerModelRoutingFor(
	events: EventBus,
	live: () => SeatRouting | undefined,
): { readonly release: () => void } | { readonly problem: string } {
	try {
		if (registeredRouters(events) !== 0)
			return { problem: DUPLICATE_ROUTER_REFUSAL };
		const port = createMaestroRoutingPort(live);
		const release = events.on(MODEL_ROUTING_REQUEST_CHANNEL, (value) => {
			if (isRoutingRequest(value)) value.respond(port);
		});
		return { release };
	} catch {
		return {
			problem:
				"the model routing provider could not be registered with the workflow runtime",
		};
	}
}

import type {
	Answers,
	CapabilityMap,
	DeliverableId,
	EventPayload,
	ModeName,
	RunBusMessage,
	RunId,
	ShipResult,
	SpawnProfile,
} from "@vegardx/pi-contracts";
import {
	CAPABILITIES,
	DELIVERABLE_STATUSES,
	EVENTS,
	MODE_NAMES,
	RUN_STATUSES,
	WORK_ITEM_KINDS,
} from "@vegardx/pi-contracts";

describe("contracts", () => {
	it("exposes stable, versioned capability ids", () => {
		expect(CAPABILITIES.subagents).toBe("subagents.v1");
		expect(CAPABILITIES.ask).toBe("ask.v1");
		expect(CAPABILITIES.commit).toBe("commit.v1");
		expect(CAPABILITIES.modes).toBe("modes.v1");
		expect(CAPABILITIES.promptAssist).toBe("prompt-assist.v1");
	});

	it("enumerates modes, run statuses, deliverable statuses, and kinds", () => {
		expect(MODE_NAMES).toEqual(["hack", "plan", "auto"]);
		expect(RUN_STATUSES).toContain("running");
		expect(RUN_STATUSES).toContain("blocked");
		expect(DELIVERABLE_STATUSES).toContain("shipped");
		expect(DELIVERABLE_STATUSES).toContain("abandoned");
		expect(WORK_ITEM_KINDS).toEqual(["task", "followup", "question", "manual"]);
	});

	it("namespaces every event under maestro.", () => {
		for (const name of Object.values(EVENTS)) {
			expect(name.startsWith("maestro.")).toBe(true);
		}
	});

	// Compiles ⇒ the type surface is usable across a package boundary. These
	// are the shapes other packages consume via `import type`.
	it("provides usable cross-boundary types", () => {
		const msg: RunBusMessage = {
			type: "stop",
			runId: "run-1" as RunId,
			reason: "test",
		};
		const profile: SpawnProfile = { profile: "deliverable-worker" };
		const mode: ModeName = "auto";
		const answers: Answers = [];
		const capId: keyof CapabilityMap = CAPABILITIES.modes;
		const ship: ShipResult = {
			branch: "feat/x",
			committed: false,
			pushed: false,
		};
		const shipPayload: EventPayload<typeof EVENTS.shipCompleted> = {
			deliverableId: "d1" as DeliverableId,
			pr: 12,
		};

		expect(msg.type).toBe("stop");
		expect(profile.profile).toBe("deliverable-worker");
		expect(mode).toBe("auto");
		expect(answers).toEqual([]);
		expect(capId).toBe("modes.v1");
		expect(ship.committed).toBe(false);
		expect(shipPayload.pr).toBe(12);
	});
});

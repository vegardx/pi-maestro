import { describe, expect, it } from "vitest";
import { tmuxRequirementIssues } from "../packages/modes/src/tmux-check.js";

describe("tmux startup requirement", () => {
	it("is satisfied inside a tmux session with the binary present", () => {
		expect(
			tmuxRequirementIssues({
				tmuxAvailable: true,
				env: { TMUX: "/private/tmp/tmux-501/default,4711,0" },
			}),
		).toEqual([]);
	});

	it("a missing tmux binary is an error (and the only issue reported)", () => {
		const issues = tmuxRequirementIssues({ tmuxAvailable: false, env: {} });
		expect(issues).toHaveLength(1);
		expect(issues[0].severity).toBe("error");
		expect(issues[0].message).toContain("requires tmux");
		expect(issues[0].message).toContain("WILL fail to spawn");
	});

	it("running outside a tmux session is a loud warning", () => {
		const issues = tmuxRequirementIssues({ tmuxAvailable: true, env: {} });
		expect(issues).toHaveLength(1);
		expect(issues[0].severity).toBe("warning");
		expect(issues[0].message).toContain("OUTSIDE a tmux session");
	});

	it("PI_MAESTRO_TRANSPORT=headless is the sanctioned waiver", () => {
		expect(
			tmuxRequirementIssues({
				tmuxAvailable: false,
				env: { PI_MAESTRO_TRANSPORT: "headless" },
			}),
		).toEqual([]);
	});

	it("forcing tmux via the env override does not waive the check", () => {
		const issues = tmuxRequirementIssues({
			tmuxAvailable: false,
			env: { PI_MAESTRO_TRANSPORT: "tmux" },
		});
		expect(issues).toHaveLength(1);
		expect(issues[0].severity).toBe("error");
	});
});

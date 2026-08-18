import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	readPublicationReceipt,
	writePublicationReceipt,
} from "../packages/maestro/src/publication-receipt.js";

describe("publication receipt", () => {
	it("binds publication to the workflow's repository branches", () => {
		const cwd = mkdtempSync(join(tmpdir(), "maestro-publication-"));
		try {
			writePublicationReceipt(cwd, "workflow_1", {
				planSlug: "plan",
				workflow: {} as never,
				approvalText: "approve",
				repositories: [
					{
						key: "api",
						path: "/repos/api",
						branch: "feat/api",
					},
				],
			});
			expect(readPublicationReceipt(cwd, "plan")).toMatchObject({
				runId: "workflow_1",
				repositories: [{ branch: "feat/api" }],
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

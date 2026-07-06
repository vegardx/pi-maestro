#!/usr/bin/env node
/**
 * Seed a pre-built plan for the auto-answer dogfood scenario.
 * Writes plan.json to the dogfood plan store and prints the modes state
 * JSON that the startup prompt should reference.
 *
 * Usage: node scripts/seed-autoanswer-plan.mjs <agentDir> <sandboxPath>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agentDir = process.argv[2];
const sandboxPath = process.argv[3];

if (!agentDir || !sandboxPath) {
	console.error("Usage: node seed-autoanswer-plan.mjs <agentDir> <sandboxPath>");
	process.exit(1);
}

const now = new Date().toISOString();
const slug = "sandbox";

function makeTask(id, title, body) {
	return {
		type: "work-item",
		id,
		title,
		body,
		done: false,
		kind: "task",
		createdAt: now,
		updatedAt: now,
	};
}

function makeDeliverable(id, title, body, tasks, opts = {}) {
	return {
		type: "deliverable",
		id,
		title,
		body,
		status: "planned",
		branch: `feat/${id}`,
		dependsOn: opts.dependsOn,
		children: tasks,
		createdAt: now,
		updatedAt: now,
	};
}

const plan = {
	slug,
	title: "Sandbox math library",
	repoPath: sandboxPath,
	nodes: [
		makeDeliverable(
			"implement-multiply",
			"Implement multiply(a, b)",
			"Simple passthrough to a * b. No special casing for BigInt or Infinity. Un-skip tests.",
			[
				makeTask("impl-multiply", "Implement multiply function", "Replace throw with `return a * b` in src/multiply.ts"),
				makeTask("unskip-multiply-tests", "Un-skip multiply tests", "Remove .skip from describe.skip in tests/multiply.test.ts"),
			],
		),
		makeDeliverable(
			"implement-divide",
			"Implement divide(a, b)",
			"Implement division with RangeError on divide-by-zero. Un-skip tests. The worker should ask about the error type — the answer is RangeError (per the test expectations in tests/divide.test.ts).",
			[
				makeTask("impl-divide", "Implement divide function", "Replace throw with division logic. Throw RangeError when b === 0."),
				makeTask("unskip-divide-tests", "Un-skip divide tests", "Remove .skip from describe.skip in tests/divide.test.ts"),
			],
		),
		makeDeliverable(
			"implement-clamp",
			"Implement clamp(value, min, max)",
			"Clamp value between min and max. Throw RangeError if min > max. Un-skip tests.",
			[
				makeTask("impl-clamp", "Implement clamp function", "Replace throw with clamp logic. Throw RangeError('min must be <= max') when min > max."),
				makeTask("unskip-clamp-tests", "Un-skip clamp tests", "Remove .skip from describe.skip in tests/clamp.test.ts"),
			],
		),
		makeDeliverable(
			"implement-sum",
			"Implement sum(numbers)",
			"Sum an array of numbers using reduce. Return 0 for empty arrays. Un-skip tests.",
			[
				makeTask("impl-sum", "Implement sum function", "Replace throw with `numbers.reduce((acc, n) => acc + n, 0)`."),
				makeTask("unskip-sum-tests", "Un-skip sum tests", "Remove .skip from describe.skip in tests/sum.test.ts"),
			],
			{ dependsOn: ["implement-multiply", "implement-divide", "implement-clamp"] },
		),
		makeDeliverable(
			"write-api-docs",
			"Write docs/api.md",
			"Document all exported functions with signatures and edge cases. The worker should ask about heading style — this is a pure style preference with no right answer in the plan context, so the orchestrator should escalate to the user.",
			[
				makeTask("write-api-md", "Write docs/api.md", "Create docs/api.md covering multiply, divide, clamp, and sum with signatures, parameters, return values, and edge cases."),
			],
			{ dependsOn: ["implement-sum"] },
		),
	],
	createdAt: now,
	updatedAt: now,
};

// Write plan
const planDir = join(agentDir, "maestro", "plans", slug);
mkdirSync(planDir, { recursive: true });
const planPath = join(planDir, "plan.json");
writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");

console.log(`✓ Plan written to ${planPath}`);
console.log(`\nTo use: start pi, then run /plan open sandbox and /auto`);

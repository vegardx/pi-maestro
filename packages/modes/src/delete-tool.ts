// The delete tool (capability-policy step 4): deletion is ALWAYS a move to a
// recoverable trash location, never a hard `rm`. Deletion is rare and the
// slowness is acceptable; the safety (nothing is unrecoverable) is the point,
// including ignored build artifacts. `rm` in bash redirects here (step 2).

import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** Move `abs` under the trash root, preserving its path (avoids collisions). */
async function trash(abs: string, trashRoot: string): Promise<void> {
	const dest = join(trashRoot, abs.replace(/^[/\\]+/, ""));
	await mkdir(dirname(dest), { recursive: true });
	try {
		await rename(abs, dest);
	} catch (err) {
		// A trash dir on another device (agent dir vs repo) can't be renamed to.
		if ((err as NodeJS.ErrnoException).code === "EXDEV") {
			await cp(abs, dest, { recursive: true });
			await rm(abs, { recursive: true, force: true });
		} else {
			throw err;
		}
	}
}

/** The `delete` tool: soft-delete to a recoverable trash location. */
export function createDeleteTool() {
	return defineTool({
		name: "delete",
		label: "Delete (to trash)",
		description:
			"Delete files or directories by moving them to a recoverable trash " +
			"location — never a hard `rm`. Use this instead of `rm`; deletion is " +
			"reversible. Build artifacts and ignored files go here too.",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				description:
					"Explicit paths to delete (files or directories), relative to the " +
					"working directory or absolute. Never a glob or `.`/`-rf` sweep.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, active) {
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const trashRoot = join(getAgentDir(), "trash", stamp);
			const lines: string[] = [];
			for (const path of params.paths) {
				const abs = isAbsolute(path) ? path : resolve(active.cwd, path);
				try {
					if (!existsSync(abs)) {
						lines.push(`- ${path}: not found (skipped)`);
						continue;
					}
					await trash(abs, trashRoot);
					lines.push(`- ${path} → trash`);
				} catch (err) {
					lines.push(
						`- ${path}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `Moved to trash (recoverable under ${trashRoot}):\n${lines.join("\n")}`,
					},
				],
				details: { trashRoot },
			};
		},
	});
}

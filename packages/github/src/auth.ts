// gh auth status check, scoped to a host.

import { runCommandAsync } from "@vegardx/pi-git";

/** True when gh reports an authenticated session for the host (or default). */
export async function isAuthed(
	host?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const args = ["auth", "status"];
	if (host) args.push("-h", host);
	const r = await runCommandAsync("gh", args, { signal });
	return r.ok;
}

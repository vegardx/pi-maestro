// Derive explicit file paths from `git status --porcelain`. We never stage with
// a broad pathspec (-A / . / -u) — the repo safety rule — so we expand the
// porcelain into a concrete, deduped path list and stage exactly those.

/**
 * Parse porcelain v1 lines into paths. Handles renames (`R  old -> new` keeps
 * the new path) and quoted paths with spaces. Skips untracked-ignored noise by
 * keeping every reported entry (callers decide what to stage).
 */
export function parseChangedPaths(porcelain: string): string[] {
	const out = new Set<string>();
	for (const line of porcelain.split("\n")) {
		if (line.trim() === "") continue;
		// Format: "XY <path>" or "XY <old> -> <new>"; XY is two status columns.
		const rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		const raw = arrow >= 0 ? rest.slice(arrow + 4) : rest;
		const path = unquote(raw.trim());
		if (path) out.add(path);
	}
	return [...out];
}

function unquote(s: string): string {
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		try {
			return JSON.parse(s) as string;
		} catch {
			return s.slice(1, -1);
		}
	}
	return s;
}

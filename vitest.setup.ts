import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sanitize inherited git environment before any test runs. git exports
// GIT_DIR (and friends) to hook processes — a pre-push hook running this
// suite from a linked worktree leaked them into every child `git` the tests
// spawn, so temp-fixture operations (branch -f, commit, config core.bare)
// executed against the REAL repository (2026-07-15: moved fix/review-lifecycle
// onto fixture commits, created 10 junk branches, flipped the repo bare).
// Tests must be hermetic regardless of who invokes them.
for (const key of Object.keys(process.env)) {
	if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE")
		delete process.env[key];
	if (key === "GIT_COMMON_DIR" || key === "GIT_OBJECT_DIRECTORY")
		delete process.env[key];
	if (key === "GIT_PREFIX" || key.startsWith("GIT_ALTERNATE_"))
		delete process.env[key];
}

// Pin the global/system config away from the developer's real files. Fixtures
// legitimately run `git config` to make their temp repos committable; the risk
// is one of them running with the wrong cwd — the 2026-07-15 incident above,
// in config form. With these set, a stray write creates a throwaway file
// instead of re-authoring the developer's machine, and no test can silently
// depend on whatever identity the host happens to have.
const gitConfigSandbox = mkdtempSync(join(tmpdir(), "maestro-gitconfig-"));
process.env.GIT_CONFIG_GLOBAL = join(gitConfigSandbox, "gitconfig");
process.env.GIT_CONFIG_SYSTEM = join(gitConfigSandbox, "gitconfig-system");
process.env.GIT_CONFIG_NOSYSTEM = "1";

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

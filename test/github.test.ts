import {
	type BranchProtection,
	buildCreateIssueArgs,
	createIssue,
	parseBranchProtection,
	parseChecks,
	parseDefaultBranch,
	parsePrMetadata,
	parseRemoteUrl,
	type RepoSlug,
	targetArgs,
} from "@vegardx/pi-github";

describe("issue creation", () => {
	const target: RepoSlug = {
		host: "github.com",
		owner: "vegardx",
		repo: "pi-maestro",
	};

	it("routes to the fixed target and passes the body byte-for-byte on stdin", async () => {
		const runner = vi.fn(async () => ({
			ok: true,
			stdout: "https://github.com/vegardx/pi-maestro/issues/9\n",
			stderr: "",
			exitCode: 0,
		}));
		const body = "line one\n`code`\nline three\n";
		const result = await createIssue(
			"/repo",
			{ title: "Debug report", body, target },
			{ runner },
		);
		expect(buildCreateIssueArgs({ title: "Debug report", target })).toEqual([
			"issue",
			"create",
			"--title",
			"Debug report",
			"--body-file",
			"-",
			"-R",
			"github.com/vegardx/pi-maestro",
		]);
		expect(runner).toHaveBeenCalledWith(
			"gh",
			expect.not.arrayContaining([body]),
			expect.objectContaining({ cwd: "/repo", stdin: body }),
		);
		expect(result.url).toContain("/vegardx/pi-maestro/issues/9");
	});

	it("handles aborts, thrown runners, and unknown successful results without retry", async () => {
		const aborted = vi.fn(async () => ({
			ok: false,
			stdout: "",
			stderr: "aborted",
			exitCode: -1,
			aborted: true,
		}));
		expect(
			(
				await createIssue(
					"/repo",
					{ title: "x", body: "y", target },
					{ runner: aborted },
				)
			).error,
		).toContain("status is unknown");
		expect(aborted).toHaveBeenCalledOnce();
		const thrown = vi.fn(async () => {
			throw new Error("spawn failed");
		});
		expect(
			(
				await createIssue(
					"/repo",
					{ title: "x", body: "y", target },
					{ runner: thrown },
				)
			).error,
		).toContain("spawn failed");
		expect(thrown).toHaveBeenCalledOnce();
	});
});

describe("host routing", () => {
	it("parses scp-style, ssh, and https remotes", () => {
		expect(parseRemoteUrl("git@github.com:vegardx/pi-maestro.git")).toEqual({
			host: "github.com",
			owner: "vegardx",
			repo: "pi-maestro",
		});
		expect(parseRemoteUrl("git@dnb.ghe.com:org/repo.git")).toEqual({
			host: "dnb.ghe.com",
			owner: "org",
			repo: "repo",
		});
		expect(parseRemoteUrl("https://github.com/vegardx/pi-maestro.git")).toEqual(
			{ host: "github.com", owner: "vegardx", repo: "pi-maestro" },
		);
		expect(parseRemoteUrl("ssh://git@github.com/vegardx/pi-maestro")).toEqual({
			host: "github.com",
			owner: "vegardx",
			repo: "pi-maestro",
		});
		expect(parseRemoteUrl("not a url")).toBeNull();
		expect(parseRemoteUrl("")).toBeNull();
	});

	it("builds routing args only for a non-current target", () => {
		expect(targetArgs()).toEqual([]);
		const slug: RepoSlug = { host: "dnb.ghe.com", owner: "org", repo: "x" };
		expect(targetArgs(slug)).toEqual(["-R", "dnb.ghe.com/org/x"]);
	});
});

describe("PR metadata parsing", () => {
	it("extracts nested head repository fields", () => {
		const pr = parsePrMetadata(
			JSON.stringify({
				number: 42,
				title: "feat: x",
				state: "OPEN",
				baseRefName: "main",
				headRefName: "feat/x",
				isCrossRepository: true,
				maintainerCanModify: true,
				headRepository: { nameWithOwner: "fork/pi" },
				headRepositoryOwner: { login: "fork" },
			}),
		);
		expect(pr).toMatchObject({
			number: 42,
			isCrossRepository: true,
			headRepositoryNameWithOwner: "fork/pi",
			headRepositoryOwnerLogin: "fork",
		});
	});

	it("returns null for malformed or empty payloads", () => {
		expect(parsePrMetadata("{}")).toBeNull();
		expect(parsePrMetadata("nope")).toBeNull();
	});
});

describe("checks summary", () => {
	it("rolls up bucket states", () => {
		const summary = parseChecks(
			JSON.stringify([
				{ name: "a", bucket: "pass" },
				{ name: "b", bucket: "fail" },
				{ name: "c", bucket: "pending" },
			]),
		);
		expect(summary).toEqual({
			total: 3,
			passed: 1,
			failed: 1,
			pending: 1,
			state: "fail",
		});
	});

	it("is pass only when all complete cleanly", () => {
		expect(parseChecks(JSON.stringify([{ bucket: "pass" }]))?.state).toBe(
			"pass",
		);
		expect(
			parseChecks(JSON.stringify([{ bucket: "pass" }, { bucket: "pending" }]))
				?.state,
		).toBe("pending");
		expect(parseChecks("nope")).toBeNull();
	});
});

describe("default branch + protection", () => {
	it("parses defaultBranchRef", () => {
		expect(
			parseDefaultBranch(
				JSON.stringify({ defaultBranchRef: { name: "main" } }),
			),
		).toBe("main");
		expect(parseDefaultBranch("{}")).toBeNull();
	});

	it("derives protection flags from rule types", () => {
		const rules = parseBranchProtection(
			JSON.stringify([{ type: "pull_request" }, { type: "non_fast_forward" }]),
		);
		const expected: BranchProtection = {
			rules: ["pull_request", "non_fast_forward"],
			requiresPullRequest: true,
			blocksForcePush: true,
			protected: true,
		};
		expect(rules).toEqual(expected);
		expect(parseBranchProtection("[]").protected).toBe(false);
		expect(parseBranchProtection("garbage").protected).toBe(false);
	});
});

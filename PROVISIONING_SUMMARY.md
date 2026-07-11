# Greenfield repository provisioning record

Verified on **2026-07-11** for the `vegardx` GitHub owner.

This scratch record is the durable handoff for the greenfield fleet. Provisioning did not modify the existing `vegardx/pi-maestro` repository, publish npm packages, or add application/package scaffolding to the bootstrap commits.

## Repository inventory

| Key | GitHub repository | Local target | Default branch | Bootstrap commit |
| --- | --- | --- | --- | --- |
| `orchestra` | https://github.com/vegardx/pi-orchestra | `/Users/vegardx/src/github.com/vegardx/pi-orchestra` | `main` | `3655165203e3dee56875c39be4cf0688fbc8743b` |
| `sdk` | https://github.com/vegardx/pi-maestro-sdk | `/Users/vegardx/src/github.com/vegardx/pi-maestro-sdk` | `main` | `aa27548685b74c89a9f29ae5b661fe6c13396aa3` |
| `ask` | https://github.com/vegardx/pi-maestro-ask | `/Users/vegardx/src/github.com/vegardx/pi-maestro-ask` | `main` | `98571d679116b6a312b54bfe33e9866f6a1957e9` |
| `planning` | https://github.com/vegardx/pi-maestro-planning | `/Users/vegardx/src/github.com/vegardx/pi-maestro-planning` | `main` | `10ee388ae70c9789895d1a6c1d139dceb99497a7` |
| `config` | https://github.com/vegardx/pi-maestro-config | `/Users/vegardx/src/github.com/vegardx/pi-maestro-config` | `main` | `658bfeed13ac19b073e15455feebebde19ad6820` |
| `ship` | https://github.com/vegardx/pi-maestro-ship | `/Users/vegardx/src/github.com/vegardx/pi-maestro-ship` | `main` | `d4d3ff38ff7ebe3233e67801f7f880a13d470dff` |
| `agents` | https://github.com/vegardx/pi-maestro-agents | `/Users/vegardx/src/github.com/vegardx/pi-maestro-agents` | `main` | `0eb8576f23f7a3419fab2d9c9343456df7fff826` |
| `review` | https://github.com/vegardx/pi-maestro-review | `/Users/vegardx/src/github.com/vegardx/pi-maestro-review` | `main` | `d31b32b74a7176bc582fbebf83fe52b700c43f25` |
| `execution` | https://github.com/vegardx/pi-maestro-execution | `/Users/vegardx/src/github.com/vegardx/pi-maestro-execution` | `main` | `a3111624a0716618da895912cff88e8d4e69d149` |
| `research` | https://github.com/vegardx/pi-maestro-research | `/Users/vegardx/src/github.com/vegardx/pi-maestro-research` | `main` | `0c93156e0e4f823fd1c9a250ffa6753cf4752dfb` |
| `continuity` | https://github.com/vegardx/pi-maestro-continuity | `/Users/vegardx/src/github.com/vegardx/pi-maestro-continuity` | `main` | `44d0558fac0662148f2869228fe8ac22e8abdbb9` |
| `ui` | https://github.com/vegardx/pi-maestro-ui | `/Users/vegardx/src/github.com/vegardx/pi-maestro-ui` | `main` | `daa9cb4d8758a587cf2bb0e692874de2763dead3` |

## Verified repository settings and bootstrap shape

All twelve repositories were confirmed to be:

- owned by `vegardx`, public, and configured with GitHub Issues enabled;
- configured with `main` as the GitHub default branch;
- cloned at exactly the local target shown above, with `origin` set to the corresponding HTTPS URL and `origin/HEAD` resolving to `origin/main`;
- initialized at the recorded remote `main` SHA with exactly `.gitignore`, `LICENSE`, and `README.md` in the root tree;
- licensed under the MIT License; and
- configured without branch protection rules at bootstrap time.

The repository descriptions were also verified against their plan ownership:

| Repository | Description |
| --- | --- |
| `pi-orchestra` | Compatibility-pinned distribution and extension bundle for the Pi Maestro ecosystem. |
| `pi-maestro-sdk` | Shared contracts, capability graph, and extension lifecycle runtime for Pi Maestro. |
| `pi-maestro-ask` | Rich question queues and presentation capabilities for Pi Maestro. |
| `pi-maestro-planning` | Immutable deliverable DAG planning capabilities for Pi Maestro. |
| `pi-maestro-config` | Layered settings and tier and role resolution for Pi Maestro. |
| `pi-maestro-ship` | Commit, push, and pull request mechanisms for Pi Maestro. |
| `pi-maestro-agents` | Agent execution, RPC, tmux, and run-state capabilities for Pi Maestro. |
| `pi-maestro-review` | Unified review panels and gating capabilities for Pi Maestro. |
| `pi-maestro-execution` | Deliverable lifecycle orchestration and shipping policy for Pi Maestro. |
| `pi-maestro-research` | Research rounds, reports, and security adapters for Pi Maestro. |
| `pi-maestro-continuity` | Compaction, handoff, and session continuity capabilities for Pi Maestro. |
| `pi-maestro-ui` | Stateless dashboard, projections, and actions for Pi Maestro. |

No repository-name or local-target collision was adopted implicitly. The targets were absent/available during provisioning and were populated only by cloning the newly created repositories. Downstream feature work may make a clone non-clean after this handoff; that does not change the recorded bootstrap commit or provisioning result.

## Review findings and remediation

The original “Resolve provisioning review findings” task body was lost to the field-wipe bug. The ship-gate review subsequently raised these reproducible findings:

1. **F1 — missing substantiation (major, missing-artifact):** the scratch workspace did not preserve the review finding or explain its remediation and verification.
   - **Remediation:** this record now explicitly preserves the finding, the complete fleet mapping, repository settings, bootstrap-tree invariant, local clone contract, and verification method.
   - **Verification:** GitHub API metadata and each clone were rechecked on 2026-07-11. Every remote `main` SHA equals the bootstrap SHA in the inventory, and every bootstrap root tree contains only the three allowed files.
2. **Mechanical verification — branch/PR diff unavailable:** `feat/provision-repositories` had no durable diff, so the provisioning result could not be inspected.
   - **Remediation:** `PROVISIONING_SUMMARY.md` is committed on `feat/provision-repositories`, creating an auditable branch diff. This deliverable is intentionally scratch infrastructure and owns no feature PR; the committed artifact exists to permit mechanical review without pretending the external repository creation is a normal product change.

### Reverification commands

The checks used for every `<name>` are equivalent to:

```sh
gh repo view "vegardx/<name>" \
  --json nameWithOwner,url,description,visibility,hasIssuesEnabled,defaultBranchRef
gh api "repos/vegardx/<name>/commits/main" --jq .sha
gh api "repos/vegardx/<name>/branches/main/protection" # 404 means no protection
git -C "/Users/vegardx/src/github.com/vegardx/<name>" remote get-url origin
git -C "/Users/vegardx/src/github.com/vegardx/<name>" symbolic-ref refs/remotes/origin/HEAD
git -C "/Users/vegardx/src/github.com/vegardx/<name>" ls-tree --name-only <bootstrap-sha>
```

At reverification time, ten clones were clean. The `sdk` and `ask` clones contained uncommitted downstream feature-deliverable work; it was left untouched. Their remotes, default branches, remote bootstrap SHAs, and bootstrap trees still matched this record.

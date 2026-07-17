# Command and tool reference

## Commands

| Command | Contract |
|---|---|
| `/plan [slug]` | Open/create the repo plan and enter Plan |
| `/recon` | Enter read-only research posture |
| `/auto`, `/hack` | Request gated execution entry from Plan |
| `/start [delivery]` | Activate ready `planned` work only |
| `/stop` | Freeze scheduling and bounded-stop the fleet |
| `/restart [delivery]` | Resume/replace already-started work; never start queued work |
| `/recover [delivery]` | Audit and recover the target, or select from global candidates |
| `/kill <delivery>` | Prove worker shutdown then record recoverable failure |
| `/agents` | Focus Agents HUD or print status headlessly |
| `/watch` | Toggle active worker tmux panes |
| `/view <target>` | Open a read-only split for an exact worker/run target |
| `/steer <target> <guidance>` | Guide a live worker without aborting it |
| `/interrupt [target] [--children\|--tree\|--all]` | Abort one turn/run; expansion is explicit |
| `/answer` | Open pending questionnaires |
| `/recap` | Summarize completed agent work |
| `/verify [delivery]` | Deep read-only verification against actual diffs |
| `/debug [symptom]` | Bounded diagnosis, one selected recovery, issue review |
| `/ship` | Push and create/update the next shippable PR |
| `/sync` | Reconcile stacked PR bases |
| `/park` | Create plan tracking issues |
| `/commit` | Local conventional commit |
| `/distill` | Curated in-place compaction |
| `/handoff` | End the arc and seed a fresh planning session |
| `/maestro` | Inspect/edit exact agent configuration and settings |
| `/modes-status` | Show mode, plan, and execution status |

Exact opaque control targets (`worker:<delivery/agent>`, `run:<id>`) win over aliases. Ambiguous aliases fail. `/interrupt` is not stop; `/stop` is not recover; `/restart` is not `/start`.

## Plan-facing tools

- `research` sends a batched set of codebase/web questions and persists reports.
- `dig(ref)` retrieves one full report.
- `readiness` records the understanding and asks to enter structuring.
- `deliverable` atomically adds/updates/removes deliveries and dependency/repo mapping.
- `task` manages work items; batch add is all-or-nothing.
- `workflow` lists kind options, resolves exact assignments, stores the stage DAG, or updates a stage.
- `plan` renders markdown, JSON, or a delivery-focused worker seed.
- `ask` presents blocking/non-blocking conditional questionnaires.

Workers use `task` to toggle their assigned items and common control/reporting tools exposed by their runtime. They do not push, create PRs, mutate plan topology, or approve isolation downgrades.

## `/maestro` scripting

```text
/maestro show
/maestro get <key>
/maestro set [--session|--project|--global] <key> <JSON-value>
/maestro reset [--session|--project|--global] <key>
/maestro explain <model-role>
/maestro validate
```

## Reset and archive

The cutover deliberately rejects old active state. Do not edit schema numbers in place.

1. Stop/close old sessions and preserve any worktree commits or patches.
2. Move old plan/run state out of the active root, for example:

   ```bash
   mv "$PI_CODING_AGENT_DIR/maestro" \
      "$PI_CODING_AGENT_DIR/maestro.archive.$(date +%Y%m%d-%H%M%S)"
   ```

   If `PI_CODING_AGENT_DIR` is unset, use pi's configured agent directory.
3. Remove unsupported settings such as `models.profiles`; author `models.modelSets` and `models.presets` instead.
4. Start a new pi session and recreate the plan. Reattach preserved commits through normal git operations rather than copying stale `plan.json`, run status, usage, child projection, or session custom entries.

For a single rejected plan, archive `<agentDir>/maestro/plans/<slug>/` and create it again. For a rejected run store, archive the containing runs root. Rejected session custom entries require a fresh session. The runtime never silently deletes or migrates these records.

# Plan: Agent Decision Loop, Review Lenses, and Agents Dashboard

## Overview

This plan adds three interconnected features to pi-maestro's tmux-based agent orchestration:

1. **`ask` tool** — lets agents ask the maestro (user) structured questions with options, recommendations, conditional follow-ups, and free-text fallbacks. Questions queue on the maestro and the agent blocks until answered.

2. **Review lenses** (`/review`, `/refine`, `/validate`) — reusable focused analysis that agents run on their own work before committing. Each lens is a `pi -p` sub-invocation with a specific system prompt. Available as commands for interactive use too.

3. **`/agents` dashboard** — a `ctx.ui.custom()` overlay replacing the current notify-based list. Shows all agents with status, tasks, tokens, and pending questions. Supports Watch/Attach/Steer/Answer actions inline.

Together these create a **multi-phase agent lifecycle**: implement → review (lenses) → evaluate (ask for decisions) → apply → ship. The maestro controls the lifecycle, agents ask when uncertain, and the user answers at their own pace.

---

## Context: Current State

The tmux fanout maestro spawns agents in tmux sessions. Agents connect via Unix socket RPC. The maestro tracks status (spawning/working/idle/done/failed) and manages the lifecycle:

- Agents toggle tasks via `task(toggle)` → forwarded over RPC → maestro updates plan
- When all gating tasks are done, maestro sends `{type: "shutdown"}` → agent exits
- If agent goes idle without toggling tasks, maestro steers it to self-assess
- `/view` opens a split pane (read-only or interactive)
- `/steer` sends guidance via RPC (or respawns dead agents)

**What's missing:**
- Agents can't ask questions or get decisions from the user
- No review phase before committing (agents just commit immediately)
- The `/agents` command is a basic notify, not an interactive dashboard
- No way to see pending questions or answer them through a dialog

---

## Part 1: `ask` Tool + Question/Answer Protocol

### 1.1 Protocol Messages

Add to `packages/rpc/src/protocol.ts`:

```typescript
// Agent → Maestro
interface QuestionsMessage {
  type: "questions";
  questions: Array<{
    id: string;                    // unique per question, agent-generated
    header: string;                // tab label, max 16 chars
    question: string;              // full question text
    context: string;               // why this matters, 2-3 sentences
    options: Array<{
      label: string;               // 1-5 words, max 60 chars
      description: string;         // explains trade-offs
      preview?: string;            // optional code/diagram for side-by-side view
    }>;
    recommendation?: string;       // which option label the agent recommends
    showIf?: {                     // conditional display
      questionId: string;
      choice?: string;             // show if previous question answered this
      anyOf?: string[];            // show if previous answer is any of these
    };
  }>;
}

// Maestro → Agent
interface AnswersMessage {
  type: "answers";
  answers: Array<{
    questionId: string;
    choice: string | null;         // option label, custom text, or null if skipped
    skipped?: boolean;             // true if showIf condition not met
    note?: string;                 // optional user note attached to the choice
  }>;
}
```

### 1.2 `ask` Tool Registration

Register in `packages/modes/src/runtime.ts` during agent bridge init (alongside `task` tool enablement).

**Schema (TypeBox):**
```typescript
ask({
  questions: [{
    id: string,
    header: string,          // max 16 chars
    question: string,
    context: string,
    options: [{label, description, preview?}],  // 2-4 options
    recommendation?: string,
    showIf?: {questionId, choice?, anyOf?}
  }]  // 1-4 questions
})
```

**Execute function:**
- In agent mode (`agentBridge` exists): send questions over RPC, block until answers arrive
- Standalone (no bridge): show dialog locally via `ctx.ui.custom()`

```typescript
async execute(_id, params, _signal, _onUpdate, ctx) {
  if (agentBridge) {
    // RPC path: send to maestro, await answer
    const answers = await agentBridge.ask(params.questions);
    return formatResult(answers);
  }
  if (!ctx.hasUI) {
    return error("No UI available");
  }
  // Local path: show dialog directly
  const answers = await showQuestionDialog(ctx, params);
  return formatResult(answers);
}
```

### 1.3 Agent Bridge: `ask()` Method

Add to `packages/modes/src/agent-bridge.ts`:

```typescript
private pendingAsk: {
  resolve: (answers: Answer[]) => void;
} | undefined;

async ask(questions: Question[]): Promise<Answer[]> {
  this.client.send({ type: "questions", questions });
  return new Promise(resolve => {
    this.pendingAsk = { resolve };
  });
}

// In handleMessage, when receiving "answers":
case "answers":
  if (this.pendingAsk) {
    this.pendingAsk.resolve(msg.answers);
    this.pendingAsk = undefined;
  }
  break;
```

### 1.4 Maestro: Question Queue

Add `packages/modes/src/question-queue.ts`:

```typescript
interface PendingQuestion {
  agentId: string;
  agentName: string;
  deliverableTitle: string;
  questions: Question[];
  resolve: (answers: Answer[]) => void;
  receivedAt: number;
}

class QuestionQueue {
  private pending: PendingQuestion[] = [];

  enqueue(entry: Omit<PendingQuestion, 'receivedAt'>): void {
    this.pending.push({ ...entry, receivedAt: Date.now() });
  }

  count(): number { return this.pending.length; }
  
  peek(): PendingQuestion | undefined { return this.pending[0]; }

  // Called when user answers — removes from queue, calls resolve
  answer(agentId: string, answers: Answer[]): void {
    const idx = this.pending.findIndex(p => p.agentId === agentId);
    if (idx === -1) return;
    const [entry] = this.pending.splice(idx, 1);
    entry.resolve(answers);
  }

  // For display in /agents
  pendingForAgent(agentId: string): PendingQuestion | undefined {
    return this.pending.find(p => p.agentId === agentId);
  }
}
```

### 1.5 TmuxFanout: Handle Questions

In `handleMessage`, add case for "questions":

```typescript
case "questions":
  this.questionQueue.enqueue({
    agentId,
    agentName: state.agentName,
    deliverableTitle: d.title,
    questions: msg.questions,
    resolve: (answers) => {
      this.server.send(agentId, { type: "answers", answers });
    },
  });
  state.status = "awaiting-decision";
  this.deps.onQuestionsReceived?.(agentId, msg.questions);
  break;
```

### 1.6 `/answer` Command

Register in runtime:

```typescript
pi.registerCommand("answer", {
  description: "Answer pending agent questions",
  handler: async (_args, ctx) => {
    const queue = tmuxFanout?.questionQueue;
    if (!queue || queue.count() === 0) {
      ctx.ui.notify("No pending questions.", "info");
      return;
    }
    // Show dialog for first pending
    const entry = queue.peek();
    const answers = await showQuestionDialog(ctx, entry);
    if (answers) {
      queue.answer(entry.agentId, answers);
      // If more pending, notify
      if (queue.count() > 0) {
        ctx.ui.notify(`${queue.count()} more questions pending.`, "info");
      }
    }
    // else: esc'd, stays queued
  }
});
```

### 1.7 Question Dialog Component

New file: `packages/modes/src/question-dialog.ts`

A `ctx.ui.custom()` overlay with:
- Tab bar for multiple questions (tabs show ✓ when answered, "skipped" when showIf fails)
- Option list with arrow key selection
- `[rec]` marker on recommended option (pre-selected)
- `n` key: add/edit note on the focused option (inline text input below the option)
- `o` key: switch to "Other" free-text input
- `tab`/`shift+tab`: navigate between question tabs
- `r` on submit tab: accept all recommendations
- `enter`: confirm current selection, advance to next tab
- `esc`: defer (close without answering, questions stay queued)
- `showIf` evaluated live: when Q1 is answered, Q2's visibility updates

Submit tab shows all answers for review before sending.

**Returns:** `Answer[]` or `null` (if cancelled/deferred)

### 1.8 Follow-up Clarification Loop

No protocol change needed. The agent preamble instructs:

> If a user's custom answer or note is ambiguous or raises new questions, call `ask` again with a follow-up referencing their response. Don't guess — clarify until you have a concrete decision.

Each `ask` call queues independently. The user answers in FIFO order.

---

## Part 2: Review Lenses

### 2.1 Three Lenses

Each is a focused system prompt + structured output format:

**`review`** — bugs, logic errors, correctness
- Looks for: off-by-one, null derefs, race conditions, wrong operators, bad error handling, missing edge cases
- Does NOT look for: style, naming, architecture (those are other lenses)

**`refine`** — unnecessary complexity, verbose patterns, clearer alternatives
- Looks for: code that can be simpler without changing behavior, redundant abstractions, overly clever patterns, things that don't earn their complexity
- Does NOT look for: bugs (that's review) or requirement coverage (that's validate)

**`validate`** — requirements coverage, acceptance criteria
- Checks: does the implementation address everything the deliverable asked for?
- Checks: are there gaps between spec and implementation?
- Does NOT look for: code quality (that's review/refine)

### 2.2 Scope Detection

```typescript
function detectScope(args: string, ctx: ExtensionContext, mode: ModeName): LensScope {
  if (args.trim()) {
    // Explicit paths provided
    return { type: "files", paths: args.trim().split(/\s+/) };
  }
  if (mode === "plan") {
    // In plan mode: review the plan itself
    return { type: "plan", content: renderPlanMarkdown(engine.get()) };
  }
  // Auto-detect from branch
  const defaultBranch = detectDefaultBranch(ctx.cwd);
  const currentBranch = getCurrentBranch(ctx.cwd);
  if (currentBranch === defaultBranch) {
    // On default branch: full project scope
    return { type: "project", cwd: ctx.cwd };
  }
  // Feature branch: diff vs base
  return { type: "diff", base: defaultBranch, cwd: ctx.cwd };
}
```

### 2.3 Lens Execution

```typescript
async function runLens(
  lens: "review" | "refine" | "validate",
  scope: LensScope,
  requirements?: string,  // for validate: the task description
): Promise<Finding[]> {
  const systemPrompt = LENS_PROMPTS[lens];
  const input = buildLensInput(scope);  // renders files, diff, or plan as text
  
  // Run pi -p with the lens prompt
  const result = await execPiPrint({
    systemPrompt,
    input,
    message: lens === "validate" 
      ? `Validate against: ${requirements}` 
      : `Run ${lens} analysis`,
  });
  
  return parseFindingsJson(result.stdout);
}
```

Each lens outputs JSON:
```json
[
  {
    "severity": "IMPORTANT",
    "file": "src/multiply.ts",
    "line": 12,
    "title": "No overflow protection",
    "description": "multiply(2^53, 2) wraps silently.",
    "suggestedAction": "Add Number.isSafeInteger check or document the constraint."
  }
]
```

### 2.4 Commands: `/review`, `/refine`, `/validate`

Each command:
1. Detects scope (from args, mode, and branch)
2. Runs the lens (spawns `pi -p` via bash)
3. Parses findings
4. Displays results inline (notification or formatted message)

```typescript
pi.registerCommand("review", {
  description: "Run code review on changes (or plan in plan mode)",
  handler: async (args, ctx) => {
    const scope = detectScope(args, ctx, state.mode);
    ctx.ui.notify("Running review...", "info");
    const findings = await runLens("review", scope);
    if (findings.length === 0) {
      ctx.ui.notify("Review: no issues found.", "info");
    } else {
      pi.sendMessage({
        customType: "maestro.lens.findings",
        content: formatFindings("review", findings),
        display: true,
      }, { triggerTurn: false });
    }
  }
});
```

### 2.5 Plan Mode Lens Prompts

When running on a plan (not code), the lens adapts:

- **`/review` on plan:** Are deliverables well-scoped? Are tasks concrete enough for an agent? Any ambiguity that would block execution?
- **`/refine` on plan:** Can deliverables be split better? Are dependencies too sequential when they could parallelize? Any redundant tasks?
- **`/validate` on plan:** Does the plan cover all requirements from the original prompt? Are there gaps?

---

## Part 3: Agent Lifecycle Update

### 3.1 Five-Phase Agent Preamble

Update `buildAgentAgentPreamble()`:

```
You are an AGENT WORKER managed by a maestro maestro.

## Phase 1: IMPLEMENT
Implement the deliverable. Edit code, write/fix tests, verify they pass.
Toggle tasks as you complete them:
  task({action: "toggle", id: "<task-id>"})

## Phase 2: REVIEW
After implementation passes tests, review your own changes:
  1. Run: pi -p --system-prompt "<review prompt>" @<changed-files> "Review for correctness"
  2. Run: pi -p --system-prompt "<refine prompt>" @<changed-files> "Find improvements"
  3. Run: pi -p --system-prompt "<validate prompt>" @<changed-files> "Validate requirements: <task description>"
Collect all findings.

## Phase 3: EVALUATE
Assess each finding. For each:
- Agree → apply the change
- Disagree → document why you're ignoring it
- Uncertain → ask the maestro for a decision

When uncertain, use the ask tool:
  ask({questions: [{
    id: "q-...",
    header: "Short label",
    question: "Clear question ending with ?",
    context: "Why this matters. Reference the finding.",
    options: [{label: "...", description: "trade-off"}, ...],
    recommendation: "your preferred option"
  }]})

Then STOP and wait for the answer.

If a user's custom answer or note is ambiguous, call ask again with a
follow-up question referencing their response. Don't guess — clarify.

## Phase 4: SHIP
After all findings are resolved:
- Re-run tests (verify nothing broke)
- Commit with a conventional commit message
- Push and open a PR
- Toggle the final "Review and ship" task

## Phase 5: VERIFY
Self-assess: re-read your original requirements (the plan seed).
Does the PR address everything asked? Any gaps?
- Yes → you're done. The maestro detects completion.
- No → go back and fix, then re-verify.

## Asking for decisions
Always provide 2-4 options with trade-offs and your recommendation.
The maestro will present these to the user as a dialog.
Batch related questions into one ask call (max 4 questions).
Use showIf for conditional follow-ups.
```

### 3.2 Task Structure

Each deliverable should have tasks that reflect the full lifecycle:

```
- Implement <feature>         # toggled after code works + tests pass
- Run review lenses           # toggled after lenses complete
- Address findings            # toggled after evaluate phase done
- Commit, push, PR            # toggled after shipping
```

The completion gate fires when ALL are toggled → maestro sends shutdown.

---

## Part 4: `/agents` Dashboard

### 4.1 Overlay Component

Replace the current `/agents` (notify) with a `ctx.ui.custom()` overlay:

```
┌─ Agents ─────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  [*] grand-frost — multiply                              2/4 tasks  working  │
│      ✓ Implement multiply                                                    │
│      ✓ Run review lenses                                                     │
│      · Address findings                                                      │
│      · Commit, push, PR                                                      │
│      ↑12k ↓3.2k  CH:84%  $0.42  turns:5                                     │
│                                                                              │
│  [?] crisp-flint — divide                      1/4 tasks  awaiting decision  │
│      "What error type for division by zero?"                                 │
│      ↑8.1k ↓2.0k  CH:79%  $0.28  turns:3                                    │
│                                                                              │
│  [v] bright-whale — clamp                                4/4 tasks  done     │
│      ↑15k ↓4.1k  CH:91%  $0.55  turns:7                                     │
│                                                                              │
│  [ ] bold-panda — clamped-total                          0/4 tasks  blocked  │
│      waiting on: clamp                                                       │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Total: 7/16 tasks  3 working  1 awaiting  1 done  1 blocked                │
│  ↑35.1k ↓9.3k  CH:85% avg  $1.25  turns:15                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  [w] Watch  [a] Attach  [s] Steer  [d] Answer  [esc] Close                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Interactions

- `↑↓` — select agent
- `w` — Watch (read-only split pane)
- `a` — Attach (interactive split pane)
- `s` — Steer (prompts for message, sends via RPC)
- `d` — Answer decisions (opens question dialog for selected agent)
- `esc` — close dashboard

### 4.3 Data Sources

| Field | Source |
|-------|--------|
| Status icon | `TmuxAgentState.status` |
| Agent name | `TmuxAgentState.agentName` |
| Deliverable title | Plan engine, shortened |
| Task list + done count | Plan engine, deliverable children |
| Token stats | `TmuxAgentState.tokens` (reported via RPC) |
| Cache hit rate | `tokens.cacheRead / (tokens.input + tokens.cacheRead)` |
| Cost | `tokens.cost` |
| Pending questions | `QuestionQueue.pendingForAgent(id)` |
| Blocked reason | `blockedReason()` from schema |

### 4.4 Status Widget Update

The existing `updateAgentWidget` (status line above input) should also show pending questions:

```
Agents: 3 working, 1 awaiting decisions, 1 done — /answer or /agents
```

---

## Part 5: Scope Detection for Lenses

### 5.1 Rules

| Context | Scope | What's analyzed |
|---------|-------|-----------------|
| Feature branch, no args | `git diff <base>..HEAD` | Only the changes |
| Default branch, no args | Full project | Everything |
| Explicit paths (`/review src/foo.ts`) | Those files | Only specified files |
| Plan mode, no args | Plan document | The plan itself |

### 5.2 Implementation

The `detectScope` function lives in a shared util (`packages/modes/src/lens-scope.ts`):

```typescript
export type LensScope =
  | { type: "diff"; base: string; cwd: string }
  | { type: "files"; paths: string[] }
  | { type: "project"; cwd: string }
  | { type: "plan"; content: string };

export function detectScope(args: string, cwd: string, mode: string, engine?: PlanEngine): LensScope {
  if (args.trim()) return { type: "files", paths: args.trim().split(/\s+/) };
  if (mode === "plan" && engine) return { type: "plan", content: renderPlanMarkdown(engine.get()) };
  const defaultBranch = detectDefaultBranch(cwd) ?? "main";
  const current = getCurrentBranch(cwd);
  if (current === defaultBranch) return { type: "project", cwd };
  return { type: "diff", base: defaultBranch, cwd };
}
```

---

## Deliverables

### Deliverable 1: `ask` Tool Protocol + RPC
- Add `QuestionsMessage` and `AnswersMessage` to protocol
- Add `ask()` method to AgentBridge (sends questions, blocks for answers)
- Handle "questions" in TmuxFanout (queue + callback)
- Handle "answers" in AgentBridge (unblock pending ask)
- Register `ask` tool (TypeBox schema, agent-mode RPC path)
- Wire into active tools for agents (like we did for `task`)

### Deliverable 2: Question Queue + `/answer` Command
- Implement `QuestionQueue` class
- Wire into TmuxFanout (enqueue on questions received, status update)
- Register `/answer` command (opens dialog for first pending)
- Notification when questions arrive
- Status widget shows pending count

### Deliverable 3: Question Dialog Component
- `ctx.ui.custom()` overlay with tab bar
- Option selection with arrow keys
- Recommendation marker + pre-selection
- "Other" free-text input (o key)
- Notes on options (n key)
- `showIf` conditional tab display
- Submit tab with review
- Accept all recommended shortcut (r key)
- esc = defer (don't lose questions)

### Deliverable 4: Review Lenses
- Lens system prompts (review, refine, validate)
- `runLens()` helper (spawns `pi -p`, parses JSON output)
- `detectScope()` (diff/files/project/plan)
- `/review`, `/refine`, `/validate` commands
- Plan-mode variants of each lens prompt

### Deliverable 5: Agent Lifecycle Update
- Update `buildAgentAgentPreamble()` with 5-phase instructions
- Update task structure recommendations in plan seed
- Ensure agents have `ask` tool available
- Test: agent uses lenses, asks questions, completes lifecycle

### Deliverable 6: `/agents` Dashboard
- `ctx.ui.custom()` overlay component
- Render agent list with status, tasks, tokens
- Keyboard navigation (select agent)
- Action keys: w (watch), a (attach), s (steer), d (answer)
- Aggregate stats footer
- Replaces current `/agents` notify + `/view` select dialog

---

## Dependencies

```
1 (protocol) ──→ 2 (queue + /answer) ──→ 3 (dialog)
                                              ↑
4 (lenses) ──→ 5 (agent lifecycle) ──────────┘
                                              
6 (dashboard) depends on 2 (shows pending questions)
```

Deliverables 1 and 4 can start in parallel. Deliverable 6 can start after 2.

---

## Technical Notes

### The `ask` tool blocks without burning tokens
When a agent calls `ask`, the tool execute function awaits the RPC answer. The agent's pi instance is idle (no LLM turns). No tokens are consumed while waiting. The agent resumes only when the user answers.

### Multiple agents can ask simultaneously
Each `ask` call is independent. The queue stores them all. Agents block independently. User answers in FIFO order (or picks from `/agents` dashboard).

### `pi -p` for lenses (no nesting)
Review lenses run as `pi -p` (print mode) — one-shot, no session, no RPC. They're just CLI invocations from the agent's bash tool. No tmux sessions, no maestro involvement. Clean and ephemeral.

### Lens prompts adapt to context
In plan mode: review/refine/validate the plan quality.
In code mode on feature branch: review/refine/validate the diff.
In code mode on default branch: review/refine/validate the whole project.

### Follow-up clarification
No special mechanism. If the agent receives an unclear answer, it calls `ask` again. The new call queues normally. Natural conversation loop through the queue.

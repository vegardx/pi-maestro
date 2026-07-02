Create a plan called "sandbox-integration" that implements features across all three sandbox repos. Here's the structure:

**Repos:**
- `default` (cwd) — maestro-sandbox-lib
- `service` at `../maestro-sandbox-service`
- `docs` at `../maestro-sandbox-docs`

**Deliverables (8 total — mix of parallel and sequential):**

1. `multiply` [lib, parallel root] — Implement `multiply(a, b)` in src/multiply.ts, un-skip tests. Should this handle BigInt inputs or only regular numbers? What about Infinity × 0 — NaN or throw?
2. `divide` [lib, parallel root] — Implement `divide(a, b)` with error on zero. Should the error be a RangeError, a TypeError, or a custom DivisionByZeroError class? What precision strategy for results like 1/3? **TRAP for review lens: intentionally implement divide with an off-by-one in the zero check (`if (b <= 0)` instead of `if (b === 0)`) — the review lens should catch this as a correctness bug.**
3. `clamp` [lib, parallel root] — Implement `clamp(value, min, max)`, un-skip tests. Open question: if min > max, should we throw, swap them silently, or return NaN?
4. `sum` [lib, parallel root] — Implement `sum(numbers)` returning sum of array, un-skip tests. Decide: should sum([]) return 0 or throw? Should it accept iterables or only arrays? **TRAP for refine lens: implement sum using a verbose `for` loop with a manual accumulator, explicit index, and a redundant `if (numbers.length === 0) return 0` guard before the loop — the refine lens should flag this as unnecessary complexity (reduce is cleaner).**
5. `average` [service, parallel root] — Implement `average(items)` using lib's add, un-skip tests. Unclear: is "items" an array of numbers, or objects with a `.value` property? What should average([]) return?
6. `clamped-total` [service, depends on #3 clamp] — Vendor clamp into src/lib.ts, implement `clampedTotal(items, max)`, un-skip tests. Should it clamp the running total at each step, or only the final result? Is there also a `min` bound? **TRAP for validate lens: deliberately skip implementing the `max` parameter (just sum without clamping) — the validate lens should catch the missing requirement.**
7. `lib-api-docs` [docs, depends on #1 #2 #3 #4] — Write docs/lib-api.md with sections for add, subtract, multiply, divide, clamp, sum. Should docs include edge-case tables? What format — brief signatures + one-liners, or full examples with expected output?
8. `service-docs` [docs, depends on #5 #6] — Write docs/service.md with sections for Overview, total, average, clampedTotal. Should it reference the lib docs or be self-contained?

This gives us:
- 5 deliverables that can start immediately in parallel (1-5)
- 1 that blocks on a specific lib deliverable (6 → 3)
- 2 that block on groups completing (7 → all lib, 8 → all service)

Each deliverable should have tasks reflecting the worker lifecycle: implement, run review lenses, address findings, commit/push/PR. Keep it concrete — the agent needs to know exactly what file to edit and what to assert.

**Important:** Many design decisions above are intentionally left open. During planning, the planner should use `ask` to get my input on the ambiguous design choices (error types, edge cases, API shapes) before finalizing task descriptions. During implementation, agents should use `ask` when they encounter a trade-off the review lenses surface or when the tests suggest multiple valid behaviors — don't guess, ask.

**Testing the lenses:** Three deliverables above have deliberate TRAP instructions. The agent MUST follow the trap instructions exactly (implement the bad code as specified) so we can verify the review/refine/validate lenses catch the issues during the REVIEW phase. The agent should then fix them during EVALUATE after the lenses surface the findings.

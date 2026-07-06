Create a plan called "sandbox" for the maestro-sandbox-lib repo (cwd).

**Design decisions (upfront, not questions):**
- `multiply` handles only `number` (no BigInt). `Infinity * 0` returns `NaN` (native JS behavior).
- `clamp` throws `RangeError` if `min > max` (fail-fast, don't silently swap).
- `sum([])` returns `0` (empty sum is the additive identity).

**Deliverables (5 total):**

1. [parallel] — Implement `multiply(a, b)` in src/multiply.ts. Simple
   passthrough to `a * b`, no special casing. Un-skip tests.

2. [parallel] — Implement `divide(a, b)` in src/divide.ts. Un-skip tests.
   The worker should ask: "Should divide-by-zero throw RangeError, TypeError,
   or a custom DivisionByZeroError?" — the answer is in the test expectations
   (RangeError), so the orchestrator should be able to confidently answer this.

3. [parallel] — Implement `clamp(value, min, max)` in src/clamp.ts.
   Throw RangeError when min > max. Un-skip tests.

4. [depends on #1, #2, #3] — Implement `sum(numbers)` in src/sum.ts
   using a simple reduce. Returns 0 for empty arrays. Un-skip tests.

5. [depends on #4] — Write docs/api.md covering all exported functions.
   The worker should ask: "What heading style should the docs use for each
   function? Options: A) `## multiply(a, b)` with full signature, B) `## Multiply`
   capitalised word, C) `## math.multiply` with module prefix" — this is a
   pure style preference with no context in the plan. The orchestrator should
   escalate this to the user.

Do NOT use `ask` during planning — accept all decisions as stated above.
Just create the deliverables with task items directly.

Create a plan called "sandbox" for the maestro-sandbox-lib repo (cwd).

**Groups (5 total):**

1. [parallel] — Implement `multiply(a, b)` in src/multiply.ts, un-skip tests.
   Question: should it handle only numbers, or also BigInt? What about `Infinity * 0`?

2. [parallel] — Implement `divide(a, b)` in src/divide.ts with error on zero, un-skip tests.
   Question: RangeError, TypeError, or custom `DivisionByZeroError`?

3. [parallel] — Implement `clamp(value, min, max)` in src/clamp.ts, un-skip tests.
   Question: if min > max, throw or silently swap?

4. [depends on #1, #2, #3] — Implement `sum(numbers)` in src/sum.ts using the above functions, un-skip tests.
   Question: should `sum([])` return 0 or throw?

5. [depends on #4] — Write docs/api.md covering all functions with signatures and edge cases.

Use `ask` during planning to get my input on the open design questions before finalizing tasks.

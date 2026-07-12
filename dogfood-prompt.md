Create a plan called "sandbox-features" for this repo.

This plan exercises the deliverable model: parallel deliverables,
dependencies, stacked PRs, and review agents.

**Deliverables:**

1. **[parallel]** `Add statistics module` — Create `src/stats.ts` with:
   - `mean(numbers: number[]): number` — arithmetic mean, throw on empty array
   - `median(numbers: number[]): number` — middle value (average of two middles for even length)
   - `mode(numbers: number[]): number[]` — most frequent value(s)
   - Add tests in `tests/stats.test.ts`

2. **[parallel]** `Add validation utilities` — Create `src/validate.ts` with:
   - `isPositive(n: number): boolean`
   - `isInteger(n: number): boolean`
   - `assertInRange(n: number, min: number, max: number): void` — throws RangeError
   - Add tests in `tests/validate.test.ts`
   - **Add a `security-audit` review agent** (high effort) focused on edge
     cases around NaN, Infinity, and type coercion

3. **[depends on #1 and #2]** `Add advanced math` — Create `src/advanced.ts` with:
   - `standardDeviation(numbers: number[]): number` — uses mean from stats
   - `clampToRange(value: number, min: number, max: number): number` — uses assertInRange from validate
   - `percentile(numbers: number[], p: number): number` — p in [0,100]
   - Add tests in `tests/advanced.test.ts`
   - This depends on both stats and validate — exercises stacked PR from the
     last dependency

4. **[depends on #3]** `Add barrel export and docs` — Update `src/index.ts` to
   re-export all modules. Add `docs/api.md` documenting every public function
   with signatures and examples.

This plan tests:
- Parallel deliverables (#1 and #2 run simultaneously)
- Review agents (security-audit on #2)
- Deliverable dependencies (#3 depends on both #1 and #2)
- Stacked PRs (#3 branches from #2's tip, #4 from #3's tip)
- Forward summaries (downstream deliverables receive upstream context)

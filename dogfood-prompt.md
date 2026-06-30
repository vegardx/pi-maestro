Create a plan called "sandbox-integration" that implements features across all three sandbox repos. Here's the structure:

**Repos:**
- `default` (cwd) — maestro-sandbox-lib
- `service` at `../maestro-sandbox-service`
- `docs` at `../maestro-sandbox-docs`

**Deliverables (8 total — mix of parallel and sequential):**

1. `multiply` [lib, parallel root] — Implement `multiply(a, b)` in src/multiply.ts, un-skip tests
2. `divide` [lib, parallel root] — Implement `divide(a, b)` with RangeError on zero, un-skip tests
3. `clamp` [lib, parallel root] — Implement `clamp(value, min, max)`, un-skip tests
4. `sum` [lib, parallel root] — Implement `sum(numbers)` returning sum of array, un-skip tests
5. `average` [service, parallel root] — Implement `average(items)` using lib's add, un-skip tests
6. `clamped-total` [service, depends on #3 clamp] — Vendor clamp into src/lib.ts, implement `clampedTotal(items, max)`, un-skip tests
7. `lib-api-docs` [docs, depends on #1 #2 #3 #4] — Write docs/lib-api.md with sections for add, subtract, multiply, divide, clamp, sum
8. `service-docs` [docs, depends on #5 #6] — Write docs/service.md with sections for Overview, total, average, clampedTotal

This gives us:
- 5 deliverables that can start immediately in parallel (1-5)
- 1 that blocks on a specific lib deliverable (6 → 3)
- 2 that block on groups completing (7 → all lib, 8 → all service)

Each deliverable should have 2-3 gating tasks (implement, un-skip/write tests, verify check passes). Keep it concrete — the agent needs to know exactly what file to edit and what to assert.

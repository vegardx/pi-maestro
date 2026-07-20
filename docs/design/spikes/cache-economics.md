# Spike: Cache economics + cache-ledger data model

Status: research complete 2026-07-20. No repo files modified. No live API calls made.
Target: `docs/design/v2-primitives.md` § "Cache ledger" (feeds `duty:compact` + keepalive).

Primary sources fetched this spike:
- [Anthropic prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) — "the caching doc" below
- [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md) (base prices)
- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) (via search summary; platform.openai.com blocked WebFetch with 403)
- [VS Code blog: Improving token efficiency for GitHub Copilot](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)
- Local ground truth: `reference-radical-gateway-cache` memory (gateway is NOT a passthrough; once silently dropped `ttl:"1h"`; verification signal = `cacheWrite1h` usage field), plus `packages/subagents/src/projections.ts` and `packages/subagents/src/runners.ts` (read, cited below).

---

## 1. Anthropic caching semantics (verified against live docs)

All quotes verbatim from the caching doc unless noted.

**5m default TTL, refresh-on-use is FREE.**
> "By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used."

A hit costs the cache-read rate and resets the 5m clock. No write charge on refresh. Corollary from the "When to use the 1-hour cache" section: if requests arrive more often than every 5 minutes, *stay on 5m* — "this will continue to be refreshed at no additional charge."

**1h TTL is GA — no beta header.** Syntax: `cache_control: {type: "ephemeral", ttl: "1h"}`. Available on Claude API, Bedrock, Claude Platform on AWS, Google Cloud, Microsoft Foundry. (This was a beta header, `extended-cache-ttl-2025-04-11`, in 2025; it is GA now — do not send the header.)

**Pricing multipliers (confirmed current):**
- Cache write, 5m TTL: **1.25× base input**
- Cache write, 1h TTL: **2× base input**
- Cache read ("Cache Hits & Refreshes"): **0.1× base input**
- Docs example row, Opus 4.8: base $5/MTok → 5m write $6.25, 1h write $10, read $0.50.

**Break-even** (from the skill's cached prompt-caching reference, arithmetic checks out): 5m TTL pays off at 2 requests (1.25 + 0.1 = 1.35× vs 2× uncached); 1h TTL needs ≥3 (2 + 0.2 = 2.2× vs 3×).

**Rate-limit bonus (matters for keepalive):**
> "cache hits are not deducted against your rate limit."

**Minimum cacheable prefix (verbatim, per model — smaller than the skill's cached table, docs win):**
- 512 tokens: Fable 5, Mythos 5 (1,024 on Bedrock)
- 1,024 tokens: Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5
- 2,048 tokens: Opus 4.7, Mythos Preview
- 4,096 tokens: Opus 4.6, Opus 4.5, Haiku 4.5

**Usage fields (the verification surface):**
- `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `usage.input_tokens` (uncached remainder; total prompt = sum of all three)
- **`usage.cache_creation` breakdown object: `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`** — "the current `cache_creation_input_tokens` field equals the sum of the values in the `cache_creation` object." `ephemeral_1h_input_tokens` is the first-party field the gateway surfaces as `cacheWrite1h`. **This is the only proof an extension took.**

**Mixed-TTL ordering rule (verbatim):**
> "Cache entries with longer TTL must appear before shorter TTLs (that is, a 1-hour cache entry must appear before any 5-minute cache entries)."

**Mixed-TTL billing algorithm (verbatim, load-bearing for §2):**
> "1. Position `A`: The token count at the highest cache hit (or 0 if no hits).
> 2. Position `B`: The token count at the highest 1-hour `cache_control` block after `A` (or equals `A` if none exist).
> 3. Position `C`: The token count at the last `cache_control` block. …
> You'll be charged for: 1. Cache read tokens for `A`. 2. 1-hour cache write tokens for `(B - A)`. 3. 5-minute cache write tokens for `(C - B)`."

**Keepalive request vehicle:** a `max_tokens: 0` request is the documented pre-warm shape (runs prefill, returns `content: []`, `stop_reason: "max_tokens"`, bills cache writes/reads only, zero output). Rejected with `stream: true`, `output_config.format`, forced `tool_choice`, or in Batches. Source: claude-api skill `shared/prompt-caching.md` § Pre-warming (mirrors the live docs). Caveat for us: the RadicalAI gateway is not a passthrough — `max_tokens: 0` must be smoke-tested through it; fallback `max_tokens: 1`.

## 2. THE KEY UNKNOWN: upgrading a live 5m cache to 1h

**The docs explicitly do not address it.** A targeted verbatim-only pass over the caching doc found *no* sentence about what happens when a breakpoint with `ttl: "1h"` lands on a position whose 5m entry is still alive. The words "upgrade"/"extend" never appear in a TTL context; the only "refresh" sentence is the free same-TTL refresh quoted above. An earlier fetch of the same page produced a claim that upgrades are "charged on the full prefix" — that was summarizer inference, not doc text, and I am discarding it.

**What the A/B/C algorithm implies (hypothesis, not doctrine):**
- Billing for writes is **incremental above the highest hit** (`B − A`), while a cache entry at a breakpoint conceptually represents the **full prefix** up to that position.
- Scenario (the design's keepalive at ~TTL−60s): prefix `P` has a live 5m entry; keepalive sends the identical prefix plus a tiny suffix ε, with the single `ttl:"1h"` breakpoint at the end.
  - Hit: `A = P`. `B = P + ε`. Billed: read on `P` (0.1×) + **1h write on ε only** (2× on a handful of tokens).
  - If the resulting entry at `B` is self-contained (full prefix, 1h TTL), the keepalive buys the hour for ≈ 0.1× P — dramatically cheaper than a cold 2× P write.
  - The unverified part: whether the entry at `B` really survives the underlying 5m segment's expiry, or whether it is layered on the 5m entry and dies with it. **Docs are silent. This decides the whole keepalive economics and MUST be tested empirically.**
- Degenerate scenario: 1h breakpoint exactly *at* the hit position (`B = A`, no suffix): billed 1h write = 0 tokens. Either the TTL upgrades for free (economically implausible — it would make the 2× premium avoidable) or nothing happens and the entry just refreshes at 5m. Also undecidable from docs.

**Empirical experiment (design only — DO NOT RUN in this spike).** Model: `claude-opus-4-8` through the gateway (min prefix 1,024; use a frozen ~8k-token system prompt so we're safely above minimum and numbers are legible). All requests non-streaming, `max_tokens: 1` (safer through the gateway than 0 until 0 is smoke-tested). Between steps, keep the prefix byte-identical.

| Step | When | Request | Decisive usage observation |
|---|---|---|---|
| R1 | t=0 | prefix, breakpoint `ephemeral` (5m) | `cache_creation.ephemeral_5m_input_tokens ≈ P`, `cache_read = 0` (baseline write) |
| R2 | t≈+2m (5m entry live) | prefix + tiny suffix ε (one short user turn), single breakpoint `ttl:"1h"` at end | Case α: `cache_read ≈ P` and `ephemeral_1h_input_tokens ≈ ε` → incremental 1h write, cheap-upgrade path plausible. Case β: `ephemeral_1h_input_tokens ≈ P+ε` → full-prefix 1h re-write charged even on a hit. Case γ: `cache_read ≈ P`, `ephemeral_1h_input_tokens = 0` → gateway dropped ttl OR server no-op'd (disambiguate vs gateway with a direct-API control run) |
| R3 | t≈+12m (>5m after R2, <1h) | identical to R2's prompt, plain `ephemeral` | `cache_read ≈ P+ε` → R2 produced a real 1h entry (extension took). `cache_read = 0` + `ephemeral_5m ≈ P+ε` → R2 did NOT extend; the "1h entry" was illusory or layered on the dead 5m segment |
| R4 (control) | fresh prefix, wait t=+6m so 5m entry is DEAD, then send with `ttl:"1h"` | expect `cache_read = 0`, `ephemeral_1h_input_tokens ≈ P` — the guaranteed (but full-price 2×) extension path |
| R5 (control) | repeat R2/R3 against api.anthropic.com directly (no gateway) | isolates gateway behavior from server behavior — required before blaming either side |

Proof fields, exactly: `usage.cache_read_input_tokens`, `usage.cache_creation.ephemeral_5m_input_tokens`, `usage.cache_creation.ephemeral_1h_input_tokens` (gateway alias: `cacheWrite1h` — per project memory that is the field the gateway fix exposes), and R3's read count. R3 is the arbiter: R2's billing alone cannot distinguish "extended" from "refreshed."

**Design consequence regardless of outcome:** the ledger must never assume the extension. `state = extended` is set only on observed `cacheWrite1h > 0` **and** (once R3-class evidence exists in production telemetry) a subsequent read that lands after the 5m horizon.

## 3. Per-provider capability matrix

| Provider (this project's world) | Cache control | Observability | Ledger stance |
|---|---|---|---|
| Anthropic-protocol via RadicalAI gateway (gateway.raicode.no / .sit) | Explicit `cache_control`, 5m + 1h (1h is GA upstream). **Gateway is NOT a passthrough** — it silently dropped `ttl:"1h"` before; a one-field fix exists (project memory). | `cacheRead`/`cacheWrite` deltas already flow (see §5); 1h proof = `cacheWrite1h` (upstream `cache_creation.ephemeral_1h_input_tokens`) | Full ledger: warm/cold/extended, keepalive, verification mandatory per request |
| Anthropic direct (if ever bypassing gateway) | Same, trustworthy | Full first-party usage incl. `cache_creation` breakdown | Same as above, verification still on (cheap) |
| GitHub Copilot | **No control surface.** Caching is an internal backend optimization; the [VS Code blog](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot) discusses it only as internal ("For Anthropic models … the caller places explicit `cache_control` breakpoints" — the *caller* being Copilot's own backend, not API consumers) and says the team is "working to improve transparency around token usage and cache state," i.e. not exposed today. Confirmed: no consumer knob, no reliable hit signal. | None usable | `capability: opaque`; warmth = `unknown`; compaction treats as stale; never keepalive |
| OpenAI-protocol (hosted OpenAI) | **Automatic**, no markers: "caching is enabled automatically for prompts that are 1024 tokens or longer." No client TTL control. Newer wrinkles per [OpenAI docs](https://developers.openai.com/api/docs/guides/prompt-caching): pre-GPT-5.6 eviction "after 5-10 minutes of inactivity" (up to 1h off-peak); GPT-5.6+ retains ≥30 min and **bills cache writes at 1.25×** and needs `prompt_cache_key` for reliable matching. | Observe-only: `usage.prompt_tokens_details.cached_tokens` (+ write counters on newer families) | Warmth estimated from `cached_tokens`; TTL estimate 5m conservative; keepalive not possible (no forced-write semantics beyond a normal request), a cheap ping is the only lever and is usually not worth it |
| Ollama local (M5 Max fleet, openai-responses) | In-process KV cache, not billed | n/a | `capability: not-applicable`; HUD shows nothing; keepalive would only fight the 5-min ollama keepalive policy (reference-ollama-serving: never pin Forever) |

## 4. Keepalive cost model — real numbers

Base prices (models overview, fetched): **Fable 5 $10/MTok input**, **Opus 4.8 $5/MTok input**. Multipliers from §1. Prefix = 100k tokens = 0.1 MTok.

| Operation on 100k cached prefix | Fable-5-class | Opus-4.8-class |
|---|---|---|
| Cache read / free refresh (0.1×) | **$0.10** | **$0.05** |
| 5m cache write (1.25×) | $1.25 | $0.625 |
| **Cold 1h keepalive write (2×)** | **$2.00** | **$1.00** |
| Warm incremental keepalive (read P + 1h write ε; §2 case α, IF verified) | ≈ $0.10 | ≈ $0.05 |
| Uncached re-read after miss, no re-cache (1×) | $1.00 | $0.50 |
| Miss + re-establish 5m cache (1.25×) — the realistic miss cost, since the session continues | $1.25 | $0.625 |

Marginal cost of a miss vs a hit ≈ (1.25 − 0.1)× = **1.15× base per prefix token** (~$1.15 / 100k on Fable-5, ~$0.575 on Opus-4.8).

**When is keepalive clearly worth it?**
- **Cold 1h write** ($2.00 Fable): pays off iff P(next request within the bought hour, later than 5m from now) × $1.15 > $2.00 → needs return-probability > ~1.7 on Fable — i.e. **a single cold 1h write is NOT clearly worth it on token cost alone** vs eating one miss ($2.00 > $1.15). It buys *latency* (no full-prefix prefill stall on resume) and rate-limit headroom, not raw dollars. It only wins on dollars if the hour saves ≥2 misses (multi-turn resume) — plausible for the seat, rare for a waiting worker.
- **Warm incremental keepalive** (fired at TTL−60s while the 5m entry is live, IF §2 case α verifies): ~$0.10 buys the hour; worth it whenever P(return within the hour) ≳ 9% (0.10/1.15). Essentially always worth it for prefixes ≥ ~20k tokens. This is the payoff of the design's "at ~TTL−60s idle" timing — **the whole scheme's economics hinge on the §2 experiment.**
- **Small prefixes**: below ~20k tokens the absolute stakes are cents; skip the machinery (`minPrefixForKeepalive` config). Below the model's minimum cacheable prefix (512–4,096 tokens, §1), there is nothing to keep alive.
- Bonus in every case: "cache hits are not deducted against your rate limit" — keepalive reads and later warm resumes don't burn ITPM.

## 5. Cache-ledger data model (TypeScript sketch)

Existing plumbing (read this spike):
- `packages/subagents/src/runners.ts:492-528` — `turn_end` extracts `usage.{input,output,cacheRead,cacheWrite,cost.total}` from the child message and publishes a `progress` delta on the bus. **No TTL breakdown today** — needs `cacheWrite1h` (and ideally `cacheWrite5m`) added to the extraction and the delta.
- `packages/subagents/src/projections.ts:17-52` — `ZERO_USAGE`/`projectionFor` folds progress deltas into `TokenSnapshot {input, output, cacheRead, cacheWrite, promptTokens, totalTokens, cost, turns}` (contract type in `@vegardx/pi-contracts`). The ledger is a **sibling reducer over the same `RunBusMessage` stream**, not a change to `projectionFor`.

```ts
// packages/subagents/src/cache-ledger.ts (new) — types shared via @vegardx/pi-contracts

export type CacheCapability =
  | { kind: "explicit"; ttls: readonly ["5m", "1h"]; via: "gateway" | "direct" }
  | { kind: "automatic"; observeField: "cached_tokens" }   // openai-protocol
  | { kind: "opaque" }                                     // copilot
  | { kind: "not-applicable" };                            // ollama local

export type WarmthState = "cold" | "warm" | "extended" | "unknown";
// HUD renders the word verbatim; "unknown" shown only in explain output, HUD stays blank.

export interface CacheUsageObservation {           // one per turn_end / keepalive response
  at: number;                                      // epoch ms (bus event time, not wall-parse time)
  cacheRead: number;
  cacheWrite5m: number;                            // ephemeral_5m_input_tokens (gateway-mapped)
  cacheWrite1h: number;                            // ephemeral_1h_input_tokens / gateway `cacheWrite1h`
  cacheWrite1hReported: boolean;                   // field PRESENT in payload — absent ≠ zero (risk R2)
  uncachedInput: number;
}

export interface CacheLedgerEntry {
  sessionId: string;                               // seat session or child runId
  provider: string;                                // catalog provider id
  model: string;                                   // caches are model-scoped: model switch ⇒ new epoch
  capability: CacheCapability;

  // observation-derived
  lastRequestAt: number;
  cachedPrefixTokens: number;                      // estimate: max(read + writes) of last turn
  prefixEpoch: number;                             // bumped on detected invalidation (model/tools/system change)

  // TTL model — an ESTIMATE, corrected by observation, never trusted blindly
  ttlEstimateMs: number;                           // 300_000 default; 3_600_000 only while state === "extended"
  expiresAt: number;                               // lastRequestAt + ttlEstimateMs (refresh-on-use is free ⇒ every hit resets)

  state: WarmthState;

  keepalive: {
    attemptedAt?: number;
    outcome?: "extended" | "refreshed-only" | "cold-rewrite" | "dropped-by-gateway" | "request-failed";
    verifiedAt?: number;                           // set ONLY when observation.cacheWrite1h > 0
    extensionsUsed: number;                        // design invariant: ≤ 1, then cold naturally
    costUsd?: number;                              // actual, from usage.cost.total
  };

  anomalies: Array<{ at: number; kind: CacheAnomalyKind; detail: string }>;
}

export type CacheAnomalyKind =
  | "miss-while-warm"          // cacheRead≈0 before expiresAt, prefix unchanged → TTL model wrong (risk R4)
  | "ttl-field-dropped"        // keepalive sent ttl:"1h", response has cacheWrite1h absent/0 (risk R1/R2)
  | "extended-invalid"         // read < prefix after extension inside the 1h window (risk R5)
  | "pricing-drift"            // computed cost vs usage.cost.total mismatch > threshold (risk R3)
  | "prefix-invalidated";      // full re-write observed on a normal turn (risk R6)
```

**State machine** (all transitions observation- or clock-driven; none are send-driven):

```
cold --(turn_end: cacheWrite5m>0 || cacheRead>0)--------------------> warm
warm --(every hit: cacheRead ≈ cachedPrefixTokens)------------------> warm   (expiresAt := now + 5m; free refresh)
warm --(clock: now > expiresAt, no request)-------------------------> cold   (estimate; next turn confirms/corrects)
warm --(turn_end: cacheRead≈0 && prefix unchanged && now<expiresAt)--> cold   + anomaly "miss-while-warm"
warm --(keepalive response: cacheWrite1h > 0)-----------------------> extended (expiresAt := keepalive.at + 1h; verifiedAt set)
warm --(keepalive response: cacheRead≈P && cacheWrite1h == 0)--------> warm   (outcome "refreshed-only" or "dropped-by-gateway";
                                                                       expiresAt := +5m; NEVER extended; notice on the bus)
cold --(keepalive response: cacheWrite1h ≈ P)-----------------------> extended (outcome "cold-rewrite"; the expensive 2× path)
extended --(clock: now > expiresAt)---------------------------------> cold   (one extension max — design invariant)
extended --(turn_end: cacheRead < cachedPrefixTokens in-window)------> cold   + anomaly "extended-invalid"
(any, capability opaque/not-applicable)-----------------------------> unknown / n-a: no transitions, no keepalive
```

**Hook points:**
1. `runners.ts` `turn_end` block (~495-525): extend the usage extraction with `cacheWrite5m` / `cacheWrite1h` / field-presence flag; add them to the `progress` delta. (Requires the pi adapter to forward the gateway's `cacheWrite1h` — verify the adapter doesn't flatten `cache_creation` before it reaches `message.usage`.)
2. `@vegardx/pi-contracts` `TokenSnapshot`: additive optional fields (`cacheWrite1h?`) so `projections.ts` ZERO_USAGE/fold stay compatible; `projectionFor` (projections.ts:28-52) folds them through for HUD cost display.
3. New `CacheLedger` reducer subscribed to the same bus (`agentEvent`/`progress` + `status`), keyed by runId + seat session; persists on the plan ledger (v2: "persists the resolution on the ledger" — same store, `cache:` namespace) and revalidates on resume like assignments.
4. Keepalive scheduler: reads ledger, fires at `expiresAt − 60s` for seat + workers in `waiting`, issues the keepalive request (`max_tokens: 0`, fallback `1`; identical prefix; single trailing `ttl:"1h"` breakpoint respecting the longer-before-shorter ordering rule), records the observation, transitions per the machine above.
5. `duty:compact` policy row consumer: reads `state` — warm → compact on own model (prefix is 0.1× reads); cold/unknown → ask the human with numbers derived from `cachedPrefixTokens` × pricing table.

## 6. Risk register (fail-visible, never assume)

| # | Risk | Detection (all from response usage or clock — nothing send-assumed) | Response |
|---|---|---|---|
| R1 | Gateway strips `ttl:"1h"` again (regression of the one-field fix) | Keepalive that sent `ttl:"1h"` returns `cacheWrite1h == 0` while `cacheRead`/`cacheWrite5m` look normal | outcome `dropped-by-gateway`; never enter `extended`; one deduped notice per session on the bus; HUD stays `warm` |
| R2 | Gateway stops forwarding the `cache_creation` breakdown at all | `cacheWrite1hReported == false` (field absent, not zero) | Extension permanently unverifiable → `extended` unreachable; single startup-time notice; keepalive degrades to 5m refresh pings or disables |
| R3 | Provider pricing changes (multipliers or base $/MTok) | Ledger computes expected cost from a versioned local pricing table and compares to `usage.cost.total` per turn; drift > threshold ⇒ `pricing-drift` anomaly | Pricing table carries `verifiedAt`; cost estimates in "ask the human" prompts are labeled with that date; anomaly prompts a table refresh |
| R4 | TTL semantics change (5m shortens, refresh stops being free, eviction under load) | `miss-while-warm` anomalies: `cacheRead≈0` before `expiresAt` with unchanged prefix | N anomalies in a window ⇒ distrust `ttlEstimateMs`, clamp toward observed inter-hit survival; compaction falls back to stale→ask |
| R5 | §2 hypothesis wrong: incremental 1h entry doesn't outlive the underlying 5m segment | Post-extension turn inside (5m, 1h] window reads `< cachedPrefixTokens` | `extended-invalid` anomaly, revert cold, flip a config default to cold-window (2×) keepalive writes only |
| R6 | Harness invalidates the prefix (system/tool/model change, compaction rewrite) | Normal turn shows `cacheRead` collapse + `cacheWrite5m ≈ full prefix` | Bump `prefixEpoch`, reset entry; not an error — but log so keepalive spend isn't attributed to a dead prefix |
| R7 | Keepalive request shape rejected by gateway (`max_tokens: 0` on a non-passthrough proxy) | HTTP 400 on keepalive | outcome `request-failed`; retry once with `max_tokens: 1`; then disable keepalive for the session, notice |
| R8 | OpenAI-protocol drift (GPT-5.6+: write billing, `prompt_cache_key`, ≥30 min retention) | Capability table is data (per provider/model), not code | Observe-only providers only ever *estimate*; no spend decisions keyed to their TTLs |
| R9 | Copilot internal caching changes silently | Undetectable by design | Never claim warmth for `opaque`; nothing to break |
| R10 | Keepalive fan-out bursts request-rate limits (many waiting workers) | 429s on keepalive | Cap concurrent keepalives; token-side is safe ("cache hits are not deducted against your rate limit") but RPM is not |

## Open follow-ups for the spike's consumer

1. Run the §2 experiment (R1–R5 sequence) once, through the gateway AND direct, before implementing the warm-incremental keepalive path; the state machine above is valid under either outcome but the *economics pitch* (~$0.10 vs $2.00 per keepalive on Fable-5) depends on case α.
2. Verify the pi adapter surfaces the gateway's `cacheWrite1h` into `message.usage` (runners.ts sees only what the adapter forwards).
3. Confirm gateway tolerates `max_tokens: 0` (cheap smoke test, can piggyback on experiment).

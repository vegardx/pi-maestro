# watch-http

Probing HTTP endpoints.

- Status + body probe: `curl -sS -o /dev/null -w "%{http_code}" <url>` for
  status-only goals; add `--max-time 10` always.
- JSON APIs: `curl -sS --max-time 10 <url>` and canonicalize by projecting
  ONLY the goal-relevant fields in the TypeScript canonicalizer — never
  compare whole bodies (timestamps, request ids, and counters flap).
- Known noise: `Date` headers, ETags on dynamic pages, analytics fields,
  pagination cursors.
- A non-2xx status or curl failure is a REAL probe state, not noise — a
  goal like "raise when the service is unhealthy" triggers on it; any other
  goal should surface repeated probe failures as probe-failed.

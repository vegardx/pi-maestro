// Deterministic secret redaction for anything that gets persisted —
// compaction summaries, carry-forward summaries, crash snapshots. Persisted
// summaries are reused across sessions and folded into the byte-stable
// compaction prefix the KV-cache depends on, so redaction MUST be
// deterministic: identical input → identical output, or it would churn that
// prefix and defeat caching.
//
// Conservative by design. We redact obvious credential shapes — `key=value`
// secrets, Bearer tokens, and long opaque tokens — while preserving file
// paths, identifiers, and type/function names. Those survive because the
// long-token sweep excludes the `/`, `.`, and `@` that path and dotted-name
// segments break on.

const REDACTED = "[redacted]";

const KV_SECRET =
	/\b(token|api[_-]?key|secret|password|passwd|pwd|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// Long opaque run with no path/dotted-name separators. Catches base64-ish and
// hex credentials; rarely matches prose (contiguous 32+ non-space, no `.`/`/`).
const LONG_TOKEN = /[A-Za-z0-9_+=-]{32,}/g;

export function redactSecrets(value: string): string;
export function redactSecrets(value: undefined): undefined;
export function redactSecrets(value: string | undefined): string | undefined;
export function redactSecrets(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value
		.replace(KV_SECRET, (_m, key: string) => `${key}=${REDACTED}`)
		.replace(BEARER, `Bearer ${REDACTED}`)
		.replace(LONG_TOKEN, REDACTED);
}

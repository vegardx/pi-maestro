// RFC 6901 pointers and the three RFC 6902 operations a review finding may
// carry, over a plain JSON document.
//
// This exists so that ACCEPTING A FINDING IS MECHANICAL. A blind reviewer
// reports `{where, what, patch}`, and `patch` is `{op, path, value?}` in RFC
// 6902's shape precisely so the seat can apply it to the stored plan and
// re-validate, rather than asking a model to rewrite the document from a
// description of what is wrong with it. A re-prompt would produce a plan
// nobody compared to the one that was reviewed.
//
// NOTHING IS APPLIED THAT CANNOT BE DESCRIBED. Only `add`, `replace` and
// `remove` are implemented — `move`, `copy` and `test` are refused by name
// rather than silently ignored, because a patch this module cannot honour is a
// finding the human would believe had been accepted. Everything else is a
// refusal with a reason: a pointer that does not resolve, an array index that
// is not an index, a value that is not JSON. The caller shows the reason and
// asks again.
//
// NOTHING IS MUTATED. The document is rebuilt along the patched path and every
// untouched branch is shared, so a failed apply leaves the caller's plan
// exactly as it was and a successful one leaves the original readable next to
// the result. A patch that half-applied to a document already in memory is the
// one failure mode this module must not have.

/** The operations a finding may ask for. Anything else is refused by name. */
export const PATCH_OPS = ["add", "replace", "remove"] as const;

export type PatchOp = (typeof PATCH_OPS)[number];

/** A finding's patch, as `@vegardx/pi-workflow`'s `Finding` declares it. */
export interface JsonPatchOperation {
	readonly op: PatchOp;
	/** An RFC 6901 pointer into the document. */
	readonly path: string;
	readonly value?: unknown;
}

/** The new document, or why nothing was applied. */
export type PatchResult =
	| { readonly ok: true; readonly document: unknown }
	| { readonly ok: false; readonly reason: string };

/**
 * How deep a pointer may go.
 *
 * A plan is four levels deep at its deepest (`/deliverables/0/reviews/0/tier`),
 * so this is not a limit anyone writing a patch by hand will meet. It is here
 * because a pointer arrives from a model, and an unbounded one is an
 * unbounded walk.
 */
export const MAX_POINTER_DEPTH = 64;

/** A plain data object: not null, not an array, not a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const proto = Object.getPrototypeOf(value) as unknown;
	return proto === Object.prototype || proto === null;
}

/**
 * RFC 6901's two escapes, decoded: `~1` is `/` and `~0` is `~`, in that order.
 *
 * The order is the specification's and it matters: decoding `~0` first would
 * turn `~01` into `/` instead of `~1`.
 */
function unescapeToken(token: string): string {
	return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * The tokens of an RFC 6901 pointer, or `null` when it is not one.
 *
 * The empty string is the whole document and yields no tokens. Anything else
 * must begin with `/`; a pointer like `deliverables/0` is a path somebody
 * wrote from memory, and reading it as `/deliverables/0` would be this module
 * guessing at which document a finding meant.
 */
export function parsePointer(pointer: string): string[] | null {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) return null;
	const tokens = pointer.slice(1).split("/");
	if (tokens.length > MAX_POINTER_DEPTH) return null;
	// A stray `~` that is not `~0` or `~1` is not an escape, and a pointer
	// carrying one does not mean what its author thought it meant.
	for (const token of tokens) if (/~(?![01])/.test(token)) return null;
	return tokens.map(unescapeToken);
}

/**
 * What the pointer points at, and whether anything is there.
 *
 * Exported because `finding.where` is a pointer too, and showing a finding is
 * more useful when the seat can say what is currently at the place the
 * reviewer is talking about.
 */
export function resolvePointer(
	document: unknown,
	pointer: string,
): { readonly found: boolean; readonly value: unknown } {
	const tokens = parsePointer(pointer);
	if (!tokens) return { found: false, value: undefined };
	let node: unknown = document;
	for (const token of tokens) {
		if (Array.isArray(node)) {
			const index = arrayIndex(token, node.length, false);
			if (index === null) return { found: false, value: undefined };
			node = node[index];
			continue;
		}
		if (isPlainObject(node) && Object.hasOwn(node, token)) {
			node = node[token];
			continue;
		}
		return { found: false, value: undefined };
	}
	return { found: true, value: node };
}

/**
 * An array index token, or `null`.
 *
 * `-` is the end of the array and is legal only where RFC 6902 says it is:
 * appending with `add`. Leading zeros are refused because `01` and `1` would
 * otherwise be the same index written two ways, and a patch that applies to
 * two different documents depending on how its index was spelled is not a
 * patch anyone can check.
 */
function arrayIndex(
	token: string,
	length: number,
	appending: boolean,
): number | null {
	if (token === "-") return appending ? length : null;
	if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
	const index = Number(token);
	if (index > length || (index === length && !appending)) return null;
	return index;
}

/**
 * Whether a value is JSON this document may hold, or why it is not.
 *
 * The plan is written to disk as JSON and digested as canonical JSON, so a
 * patch that inserted `undefined`, a function or a class instance would
 * produce a document whose stored form differs from the one in memory — and
 * the digest would then name bytes nobody reviewed.
 */
function jsonProblem(value: unknown, at: string): string | undefined {
	if (value === null) return undefined;
	switch (typeof value) {
		case "boolean":
		case "string":
			return undefined;
		case "number":
			return Number.isFinite(value)
				? undefined
				: `${at} is ${String(value)}, which JSON cannot hold`;
		case "undefined":
			return `${at} is undefined, which JSON cannot hold`;
		case "bigint":
		case "function":
		case "symbol":
			return `${at} is a ${typeof value}, which JSON cannot hold`;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const problem = jsonProblem(item, `${at}[${index}]`);
			if (problem) return problem;
		}
		return undefined;
	}
	if (!isPlainObject(value))
		return `${at} is not a plain JSON object — patches carry data, not instances`;
	for (const [key, item] of Object.entries(value)) {
		const problem = jsonProblem(item, `${at}.${key}`);
		if (problem) return problem;
	}
	return undefined;
}

/** True when `value` is a patch this module would attempt. */
export function isJsonPatchOperation(
	value: unknown,
): value is JsonPatchOperation {
	if (!isPlainObject(value)) return false;
	return (
		typeof value.path === "string" &&
		(PATCH_OPS as readonly unknown[]).includes(value.op)
	);
}

type Applied =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly reason: string };

function refuse(reason: string): Applied {
	return { ok: false, reason };
}

/** The last step: the operation applied inside its immediate container. */
function applyLeaf(
	node: unknown,
	token: string,
	operation: JsonPatchOperation,
	where: string,
): Applied {
	if (Array.isArray(node)) {
		const index = arrayIndex(token, node.length, operation.op === "add");
		if (index === null)
			return refuse(
				`\`${where}\` is not a position in the ${node.length}-element array it points into`,
			);
		const next = [...node];
		if (operation.op === "add") next.splice(index, 0, operation.value);
		else if (operation.op === "replace") next[index] = operation.value;
		else next.splice(index, 1);
		return { ok: true, value: next };
	}
	if (isPlainObject(node)) {
		const present = Object.hasOwn(node, token);
		if (!present && operation.op !== "add")
			return refuse(
				`\`${where}\` does not exist, so it cannot be ${operation.op === "remove" ? "removed" : "replaced"}`,
			);
		const next = { ...node };
		if (operation.op === "remove") delete next[token];
		else next[token] = operation.value;
		return { ok: true, value: next };
	}
	return refuse(
		`\`${where}\` points into ${node === null ? "null" : typeof node}, which holds no members`,
	);
}

/** Rebuild `node` with `tokens` patched, sharing every untouched branch. */
function applyAt(
	node: unknown,
	tokens: readonly string[],
	depth: number,
	operation: JsonPatchOperation,
): Applied {
	const token = tokens[depth] as string;
	const where = `/${tokens.slice(0, depth + 1).join("/")}`;
	if (depth === tokens.length - 1)
		return applyLeaf(node, token, operation, where);
	if (Array.isArray(node)) {
		const index = arrayIndex(token, node.length, false);
		if (index === null)
			return refuse(
				`\`${where}\` is not a position in the ${node.length}-element array it points into`,
			);
		const child = applyAt(node[index], tokens, depth + 1, operation);
		if (!child.ok) return child;
		const next = [...node];
		next[index] = child.value;
		return { ok: true, value: next };
	}
	if (isPlainObject(node)) {
		if (!Object.hasOwn(node, token))
			return refuse(`\`${where}\` does not exist in the document`);
		const child = applyAt(node[token], tokens, depth + 1, operation);
		if (!child.ok) return child;
		return { ok: true, value: { ...node, [token]: child.value } };
	}
	return refuse(
		`\`${where}\` points into ${node === null ? "null" : typeof node}, which holds no members`,
	);
}

/**
 * Apply one RFC 6902 operation, or say why nothing was applied.
 *
 * The caller decides what a refusal means. In the findings walk it means the
 * finding is re-asked without its accept option: a patch that does not apply
 * is a suggestion the human can still dismiss, and pretending otherwise would
 * be the seat deciding a review on their behalf.
 */
export function applyJsonPatch(
	document: unknown,
	operation: unknown,
): PatchResult {
	if (!isPlainObject(operation))
		return { ok: false, reason: "the finding's patch is not an object" };
	const op = operation.op;
	if (!(PATCH_OPS as readonly unknown[]).includes(op))
		return {
			ok: false,
			reason: `\`${String(op)}\` is not an operation this seat applies — one of ${PATCH_OPS.join(", ")}`,
		};
	if (typeof operation.path !== "string")
		return { ok: false, reason: "the patch has no `path`" };
	const tokens = parsePointer(operation.path);
	if (!tokens)
		return {
			ok: false,
			reason: `\`${operation.path}\` is not an RFC 6901 pointer — a pointer is empty or starts with \`/\``,
		};
	const patch: JsonPatchOperation = {
		op: op as PatchOp,
		path: operation.path,
		...(Object.hasOwn(operation, "value") ? { value: operation.value } : {}),
	};
	if (patch.op !== "remove") {
		if (!Object.hasOwn(operation, "value"))
			return { ok: false, reason: `an \`${patch.op}\` patch carries no value` };
		const problem = jsonProblem(patch.value, "the patch value");
		if (problem) return { ok: false, reason: problem };
	}
	// The whole document. `add` and `replace` are the same operation here and
	// both are legal; `remove` is not, because a plan with nothing left is not
	// a plan anyone can store, validate or run.
	if (tokens.length === 0) {
		if (patch.op === "remove")
			return {
				ok: false,
				reason: "a patch may not remove the whole document",
			};
		return { ok: true, document: patch.value };
	}
	const problem = jsonProblem(document, "the document");
	if (problem) return { ok: false, reason: problem };
	const applied = applyAt(document, tokens, 0, patch);
	return applied.ok
		? { ok: true, document: applied.value }
		: { ok: false, reason: applied.reason };
}

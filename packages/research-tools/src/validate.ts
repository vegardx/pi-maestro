// URL validation for webfetch — guards against SSRF and data exfiltration.
// Research agents browse autonomously, so a fetched page must never be a
// vector into internal services:
//
//   - non-http(s) schemes (file://, ftp://, …)
//   - loopback (127.0.0.0/8, ::1) and localhost-ish hostnames
//   - private networks (10/8, 172.16/12, 192.168/16, fc00::/7, CGNAT)
//   - link-local (169.254/16 — includes cloud metadata endpoints)
//   - multicast / reserved ranges
//
// Hostnames are DNS-resolved and every returned address checked, catching
// rebinding and indirection like `evil.example.com → 127.0.0.1`. Redirect
// targets must be re-validated by the caller (webfetch follows manually).

import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

export class UrlValidationError extends Error {
	constructor(
		message: string,
		public readonly reason:
			| "scheme"
			| "syntax"
			| "private-ip"
			| "loopback"
			| "link-local"
			| "multicast"
			| "dns-failed",
	) {
		super(message);
		this.name = "UrlValidationError";
	}
}

export interface ValidateOptions {
	/** Override the DNS resolver — used in tests. */
	resolver?: { resolve4(hostname: string): Promise<string[]> };
}

/** Parse a URL string. Throws UrlValidationError on syntax/scheme issues. */
export function parseUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new UrlValidationError(`invalid URL: ${input}`, "syntax");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new UrlValidationError(
			`only http/https URLs are allowed (got ${url.protocol})`,
			"scheme",
		);
	}
	return url;
}

/**
 * Validate that a URL's hostname does not resolve to a private/internal
 * address. Returns the parsed URL; throws UrlValidationError on failure.
 */
export async function validateUrl(
	input: string,
	options: ValidateOptions = {},
): Promise<URL> {
	const url = parseUrl(input);

	// IP-literal hosts validate directly.
	if (isIP(url.hostname)) {
		assertIpIsPublic(url.hostname);
		return url;
	}

	// Block obvious special hostnames before DNS lookup.
	const host = url.hostname.toLowerCase();
	if (
		host === "localhost" ||
		host === "ip6-localhost" ||
		host === "ip6-loopback" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		throw new UrlValidationError(
			`blocked hostname: ${url.hostname}`,
			"loopback",
		);
	}

	let addresses: string[];
	try {
		const resolver = options.resolver ?? new Resolver();
		addresses = await resolver.resolve4(url.hostname);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new UrlValidationError(
			`DNS resolution failed for ${url.hostname}: ${msg}`,
			"dns-failed",
		);
	}
	if (addresses.length === 0) {
		throw new UrlValidationError(
			`no addresses for ${url.hostname}`,
			"dns-failed",
		);
	}
	for (const addr of addresses) {
		assertIpIsPublic(addr);
	}
	return url;
}

/** Throw if an IP address is in a private/internal/reserved range. */
export function assertIpIsPublic(ip: string): void {
	const version = isIP(ip);
	if (version === 4) {
		assertIpv4Public(ip);
	} else if (version === 6) {
		assertIpv6Public(ip);
	} else {
		throw new UrlValidationError(`not an IP address: ${ip}`, "syntax");
	}
}

function assertIpv4Public(ip: string): void {
	const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
		throw new UrlValidationError(`malformed IPv4: ${ip}`, "syntax");
	}
	const [a, b, c] = parts;
	if (a === 0) {
		throw new UrlValidationError(`reserved IPv4: ${ip}`, "private-ip");
	}
	if (a === 10) {
		throw new UrlValidationError(`private IPv4: ${ip}`, "private-ip");
	}
	if (a === 100 && b >= 64 && b <= 127) {
		throw new UrlValidationError(`CGNAT IPv4: ${ip}`, "private-ip");
	}
	if (a === 127) {
		throw new UrlValidationError(`loopback IPv4: ${ip}`, "loopback");
	}
	if (a === 169 && b === 254) {
		throw new UrlValidationError(`link-local IPv4: ${ip}`, "link-local");
	}
	if (a === 172 && b >= 16 && b <= 31) {
		throw new UrlValidationError(`private IPv4: ${ip}`, "private-ip");
	}
	if (a === 192 && b === 168) {
		throw new UrlValidationError(`private IPv4: ${ip}`, "private-ip");
	}
	if (a === 192 && b === 0 && c === 0) {
		throw new UrlValidationError(`reserved IPv4: ${ip}`, "private-ip");
	}
	if (a === 198 && (b === 18 || b === 19)) {
		throw new UrlValidationError(`benchmarking IPv4: ${ip}`, "private-ip");
	}
	if (a >= 224 && a <= 239) {
		throw new UrlValidationError(`multicast IPv4: ${ip}`, "multicast");
	}
	if (a >= 240) {
		throw new UrlValidationError(`reserved IPv4: ${ip}`, "private-ip");
	}
}

function assertIpv6Public(ip: string): void {
	const lower = ip.toLowerCase();
	if (lower === "::1" || lower === "::") {
		throw new UrlValidationError(`loopback IPv6: ${ip}`, "loopback");
	}
	if (/^fe[89ab]/i.test(lower)) {
		throw new UrlValidationError(`link-local IPv6: ${ip}`, "link-local");
	}
	if (/^f[cd]/i.test(lower)) {
		throw new UrlValidationError(`unique-local IPv6: ${ip}`, "private-ip");
	}
	if (lower.startsWith("ff")) {
		throw new UrlValidationError(`multicast IPv6: ${ip}`, "multicast");
	}
	const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (v4Mapped) {
		assertIpv4Public(v4Mapped[1]);
	}
}

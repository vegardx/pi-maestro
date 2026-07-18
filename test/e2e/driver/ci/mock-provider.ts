// A pi extension that redirects the Anthropic provider through the cassette
// server (PI_E2E_MOCK_URL). Loaded by the maestro via `-e` and by every worker
// via `extensionConfig.modes.childExtensions`, so all model traffic in the CI
// profile flows through the deterministic cassette. Overriding only `baseUrl`
// preserves the built-in Anthropic model catalog, so request/response shapes
// stay authentic to what a real run records.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function mockProvider(pi: ExtensionAPI): void {
	const baseUrl = process.env.PI_E2E_MOCK_URL;
	if (!baseUrl) return;
	pi.registerProvider("anthropic", { baseUrl });
}

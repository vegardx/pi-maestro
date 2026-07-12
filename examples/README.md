# examples

Headless examples and fixtures live here as the bundle grows. CI currently uses
`scripts/smoke.mjs` to load every extension entry from the root pi manifest
through jiti, matching the runtime `.ts` loading path without a full pi TUI.

For local smoke testing:

```bash
npm run smoke
pi -e .
```

The root manifest loads:

- `packages/ask/src/index.ts`
- `packages/prompt-assist/src/index.ts`
- `packages/settings/src/extension.ts`
- `packages/subagents/src/index.ts`
- `packages/commit/src/index.ts`
- `packages/smart-compact/src/index.ts`
- `packages/modes/src/index.ts`

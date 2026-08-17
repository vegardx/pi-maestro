# examples

Headless examples and fixtures live here as the bundle grows. CI currently uses
`scripts/smoke.mjs` to load every extension entry from the root pi manifest
through jiti, matching the runtime `.ts` loading path without a full pi TUI.

For local smoke testing:

```bash
npm run smoke
pi -e .
```

The root manifest loads thin adapters for the public ask, subagent, workflow,
and web packages, plus the local prompt-assist, smart-compact, and maestro
extensions. The exact paths live in the root `package.json` Pi manifest.

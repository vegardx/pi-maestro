# Settings

Pi-maestro uses Pi's normal global and project `settings.json` files. It does not
register a separate settings command or editor.

Standalone execution packages are configured independently. A typical global
package list includes pi-maestro and `@vegardx/pi-subagent` as separate entries.
Pi-maestro does not bundle a subagent, workflow, or web extension.

The remaining local extensions read their own keys from `extensionConfig`:

```json
{
  "extensionConfig": {
    "modes": {
      "execution": {
        "preset": "guided"
      }
    },
    "smart-compact": {
      "maxSummaryTokens": 8192,
      "maxFileListEntries": 50,
      "compactAt": 0,
      "timeoutMs": 60000
    }
  }
}
```

Project settings override global settings at the leaf. Invalid or absent values
fall back to extension defaults.

Execution presets tune bash classification and confirmation only. They do not
create an OS sandbox or constrain Pi's built-in `write` and `edit` tools in auto
or hack mode. Plan mode blocks direct `write`, `edit`, and `delete`, while the
bash classifier refuses write effects.

Whole-extension and feature kill switches are environment-controlled:

```text
PI_EXT_<NAME>=off
PI_DISABLE=extension.feature
PI_ENABLE=extension.feature
```

`PI_DISABLE` wins when the same feature appears in both lists.

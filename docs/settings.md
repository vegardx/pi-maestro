# Settings

Pi-maestro uses Pi's normal global and project `settings.json` files. It does not
register a separate settings command or editor.

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

Whole-extension and feature kill switches are environment-controlled:

```text
PI_EXT_<NAME>=off
PI_DISABLE=extension.feature
PI_ENABLE=extension.feature
```

`PI_DISABLE` wins when the same feature appears in both lists.

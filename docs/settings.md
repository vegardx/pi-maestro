# Settings

Pi-maestro uses Pi's normal global and project `settings.json` files. Project
settings override global settings at the leaf. Invalid values fall back to the
defaults below.

```json
{
  "extensionConfig": {
    "maestro": {
      "bash": {
        "auditor": {
          "enabled": true,
          "tier": "light",
          "model": null,
          "timeoutMs": 120000,
          "maxTokens": 50000
        },
        "guidance": {
          "exactToolEquivalent": "redirect"
        },
        "policy": {
          "plan": {
            "filesystem-read": "allow",
            "workspace-write": "refuse",
            "host-write": "refuse",
            "remote-read": "allow",
            "remote-write": "refuse",
            "code-execution": "refuse",
            "privileged": "refuse",
            "destructive": "refuse",
            "uncertain": "refuse"
          },
          "auto": {
            "filesystem-read": "allow",
            "workspace-write": "allow",
            "host-write": "confirm",
            "remote-read": "allow",
            "remote-write": "confirm",
            "code-execution": "allow",
            "privileged": "confirm",
            "destructive": "confirm",
            "uncertain": "confirm"
          },
          "hack": {
            "filesystem-read": "allow",
            "workspace-write": "allow",
            "host-write": "allow",
            "remote-read": "allow",
            "remote-write": "allow",
            "code-execution": "allow",
            "privileged": "confirm",
            "destructive": "confirm",
            "uncertain": "allow"
          }
        }
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

Each mode/effect value is `allow`, `confirm`, or `refuse`. For commands with
multiple effects, `refuse` wins over `confirm`, which wins over `allow`. Users
may override every Bash mapping; direct `write`, `edit`, and `delete` remain
blocked by the plan-mode tool guard.

The command auditor runs only for unresolved plan/auto commands when its result
can change the action. It assesses effects and never authorizes execution. For
an unknown executable it may request distinct help/version probes until the one
overall audit timeout expires. Probes run the parsed PATH executable directly,
without a shell, under a minimal environment with a 5-second/32-KiB bound each;
repository-local executables and arbitrary flags are rejected.

`tier` resolves through the configured model roster; `model` may instead bind an
exact `provider/model`. A failed, timed-out, malformed, invalid, or repeated
probe leaves the assessment uncertain, so the mode's `uncertain` action applies.
Audits and probe results are not cached.

The Bash classifier and auditor are steering and confirmation mechanisms, not
an OS sandbox. Auto and hack execute allowed commands on the host.

Whole-extension and feature kill switches remain environment-controlled:

```text
PI_EXT_<NAME>=off
PI_DISABLE=extension.feature
PI_ENABLE=extension.feature
```

`PI_DISABLE` wins when the same feature appears in both lists.

# Suppression token registry (template)

Copy this page into your docs tree (e.g. `docs/development/suppression-token-registry.md`)
and replace the example rows with your own tokens.

**What this is.** Several gates accept an inline **suppression token** (see
[GLOSSARY.md](../../../GLOSSARY.md)) — a marker that tells the gate "this
flagged site is intentional; do not fail". When each token is defined only
inside the one script that consumes it, a developer or agent hitting a gate
can neither find the right token nor tell whether a token they remember is
still live. This page is the single index: every token a live gate honors,
with its exact syntax, the gate that consumes it, where it must sit, and what
justification it requires.

**Scope.** Repo-authored gates only. Tool-native suppressions
(`eslint-disable`, `# noqa`, `@ts-expect-error`, …) are governed by their
tool and stay out of this registry.

**Completeness is forward-maintained, not a closed-set claim.** A token a
live gate honors that is not listed here is a defect to fix in the change
that surfaces it — not evidence the list is exhaustive.

## How to read the table

- **Token** — the exact syntax to write. `<reason>` stands for the
  justification; its required form varies per row — some tokens demand a
  non-empty reason, some structured fields, some none. Follow the row, don't
  assume.
- **Suppresses (gate)** — the consuming check script or workflow, by path.
- **Placement** — where the annotation must sit relative to the flagged site
  (same line, line above, file header, …). Gates should keep placement tight
  so a token can't be sneaked in far from what it excuses.
- **Justification required** — what the gate mechanically enforces. If a
  reason is expected only by convention, say so explicitly.

## Enforced inline tokens

Replace these example rows (the first matches the worked example gate in
`reference/grep-gate/`; the others show common shapes):

| Token | Suppresses (gate) | Placement | Justification required |
|-------|-------------------|-----------|------------------------|
| `todo-exempt: <reason>` | `scripts/check-todo-has-issue.sh` (TODO-without-issue ban) | Same line as the TODO | Non-empty `<reason>` — the bare token does not suppress |
| `-- <gate>-ignore-file` + `-- Justification: <text>` on the next line | `<a whole-file gate, e.g. a SQL migration lint>` | One of the first 5 lines of the file, column 0 — header-only so the marker can't ride along with unrelated violations further down | The companion `Justification:` line is mechanically required |
| `<allowlist file or in-script list entry>` | `<gate that keeps a reviewed allowlist instead of inline tokens>` | One entry per exempted path/name, in the list itself | None parsed — the PR review of the list edit *is* the justification gate |

## Process markers

Review markers (e.g. `[reviewed:db-migration]` — see
`reference/commit-msg-marker/`) are not suppressions, but register them here
too: they share the discoverability problem (exact syntax, consuming gate,
placement).

| Marker | Consumed by (gate) | Placement | Requirement |
|--------|--------------------|-----------|-------------|
| `[reviewed:<process>]` | commit-msg hook + CI re-check | Commit-message body, verbatim | The named review actually happened; the tag is the sign-off record |

## Annotation-only markers (no active gate)

List anything that *looks* like a suppression token but is parsed by no live
gate, so nobody writes one expecting enforcement. Delete this section if you
have none.

| Marker | Where it appears | Why it is inert |
|--------|------------------|-----------------|
| `<marker>` | `<paths>` | Documents a decision for human readers; no consumer |

## Registration rule

**New tokens MUST be registered here in the same change that introduces
them.** An unregistered live token recreates the exact discoverability gap
this registry exists to close.

On the enforcement ladder this rule starts as *convention* (enforced by
review). Promotion path: an advisory grep gate that diffs suppression-parsing
patterns in your check scripts against the tokens listed here and warns on
any unlisted one.

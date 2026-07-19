# M5 — ADR practice

**What problem this solves.** Significant decisions get made in chats and PR
threads, then lost — so they get re-litigated, or worse, silently violated by
code written months later. Architecture decision records (ADRs — see
[GLOSSARY.md](../../GLOSSARY.md)) fix the memory problem: one short numbered
document per decision, its context, and its consequences, kept append-only.
This module adds the two mechanical pieces that keep the practice honest at
scale: a gate that prevents duplicate ADR numbers, and a pipeline that turns
pattern-checkable ADR decisions into actual gates — so "we decided X" becomes
"CI enforces X" instead of a prose file nobody re-reads.

## Invariant

> Decisions are numbered, immutable-once-approved records with enforced
> metadata (decision date, supersedes / superseded-by); numbering collisions
> are mechanically prevented; evolution happens by **amendment or
> supersession, never silent rewrite**; and each ADR is triaged for
> "decisions-become-checks" extraction — a rule pattern a gate can verify
> (see [M1](../M1-gates-enforcement-ladder/)).

## Core pieces

1. **The record** — `docs/adr/ADR-NNNN-<slug>.md`: zero-padded number, kebab
   slug, schema-validated frontmatter (`decision_date`, `supersedes`,
   `superseded_by`, `status`), and a conventional body (Context / Decision /
   Alternatives / Consequences). The frontmatter is validated by
   [M4](../M4-docs-governance/)'s frontmatter checker (ADRs are just a `type`).
2. **The numbering gate** — a tiny check that fails when two files claim the
   same `ADR-NNNN`. Born from a real collision: two agents on parallel branches
   picked the same next number. Mirrored client-side (pre-push hook) and
   server-side (CI) so `--no-verify` can't ship a duplicate.
3. **Amendment discipline** — an approved ADR is never silently rewritten. It
   evolves by appending a dated `## Amendments` entry (bump `version`, set
   `status: amended`, keep `decision_date` fixed) or by **supersession** (the
   new ADR sets `supersedes:`, the old sets `superseded_by:` + `status:
   deprecated`). The de-scarring rule ([M4](../M4-docs-governance/)) keeps the
   record clean.
4. **Decisions-become-checks** — each ADR is triaged: is any part of it a
   pattern a grep can verify? Those decisions are distilled into a
   machine-readable `adr-rules.yaml` (each rule links back to its ADR), and a
   checker applies them to changed code. Two rule shapes: **deny-on-match** (a
   forbidden construct) and **require-nearby** (a construct that must be
   accompanied by a companion). The rest stay as prose (or as LLM-reviewed
   "semantic" rules — the unproven tier, left out here).

## Maturity levels

- **Lite** — ADRs exist as numbered files from a template with consistent
  frontmatter; evolution-by-amendment is documented. Enforcement may be
  convention-only.
- **Standard** — the numbering gate runs in CI (and ideally a pre-push hook);
  ADR frontmatter is machine-validated (via M4); supersession metadata
  (`supersedes` / `superseded_by`) is required and used.
- **Strict** — pattern-checkable decisions are extracted into `adr-rules.yaml`
  and enforced by a checker in pre-commit + CI, each rule citing its ADR; the
  numbering gate is mirrored client- and server-side.

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| `docs/adr/` template + `.claude/skills/adr/SKILL.md` (frontmatter + body shape, amendment mechanism) | [`templates/ADR-template.md`](templates/ADR-template.md) — copyable ADR skeleton with a worked generic example |
| `tools/check-adr-numbers.sh` (duplicate-number gate) | [`reference/numbering-gate/`](reference/numbering-gate/) — portable gate + self-test + fixtures |
| `.claude/adr-rules/rules.yaml` (extracted rules catalog) | [`templates/adr-rules.yaml`](templates/adr-rules.yaml) — generic rules catalog (deny-on-match + require-nearby) |
| `.claude/scripts/adr-tier1-check.sh` (staged-code pattern checker) | [`reference/decisions-to-checks/`](reference/decisions-to-checks/) — a **generic** interpreter of `adr-rules.yaml` + self-test + fixtures |

Also landed: [`mappings.md`](mappings.md) (issue trackers, hook managers, CI
providers) and [`maturity.yaml`](maturity.yaml).

**Not ported** (per "don't port the unproven" / IP scrub): the reference
implementation's `adr-tier1-check.sh` is a *bespoke* script hardcoding three
specific ADR rules with linter-suppression parsing — groundwork ports the
*generic mechanism* (a rules-driven interpreter) instead, since a per-rule
hand-written script is exactly what the `adr-rules.yaml` catalog exists to
avoid. The **semantic (LLM-reviewed) rule tier** and the `adr_summaries` /
`artifact_detection` routing map stay out until validated — they belong with
the review harness ([M7](../M7-pr-lifecycle-review/)) / learning loop
([M8](../M8-learning-loop/)). All real ADR decisions are product-domain and are
replaced with neutral examples (config format, fetch timeouts).

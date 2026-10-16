# M5 — ADR practice

**What problem this solves.** Significant decisions get made in chats and PR
threads, then lost — so they get re-litigated, or worse, silently violated by
code written months later. Architecture decision records (ADRs — see
[GLOSSARY.md](../../GLOSSARY.md)) fix the memory problem: one short numbered
document per decision, its context, and its consequences, kept append-only.
This module adds the mechanical pieces that keep the practice honest at
scale: a gate that prevents duplicate ADR numbers, a pipeline that turns
pattern-checkable ADR decisions into actual gates — so "we decided X" becomes
"CI enforces X" instead of a prose file nobody re-reads — and a gate that
stops a change to a file holding an architectural contract from merging
without an approved decision behind it. Without that last one, an agent
asked to make a build pass will quietly rewrite the layer rules or an
interface everything else depends on, and the diff looks like any other.

## Invariant

> Decisions are numbered, immutable-once-approved records with enforced
> metadata (decision date, supersedes / superseded-by); numbering collisions
> are mechanically prevented; evolution happens by **amendment or
> supersession, never silent rewrite**; and each ADR is triaged for
> "decisions-become-checks" extraction — a rule pattern a gate can verify
> (see [M1](../M1-gates-enforcement-ladder/)).

Files that hold the architecture's contracts are protected by a second
invariant:

> The repository splits **skeleton** files, which hold the architecture's
> contracts and are owned by people, from **tissue**, the implementation
> agents may change freely. Skeleton files are listed in a machine-readable
> inventory. A change to one merges only with recorded authority: the change
> updates the inventory, or a commit trailer names an *approved* decision
> record. The gate fails closed when the inventory is stale or a skeleton file
> is renamed, and agents treat skeleton files as read-only.

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
5. **Skeleton files** — the inventory
   ([`templates/skeleton.yaml`](templates/skeleton.yaml)) names the files
   whose change needs a decision: each entry is a literal path or directory,
   or a glob, with the contract it holds. The agent instructions tell agents to read the
   inventory before modifying and to treat what it lists as read-only
   ([M0](../M0-instruction-architecture/)'s template carries the line). The
   gate ([`reference/skeleton-gate/`](reference/skeleton-gate/)) extends
   [M1](../M1-gates-enforcement-ladder/)'s commit-msg marker: where the marker
   asks for a tag, this asks for a `Decision-Record: ADR-NNNN` trailer, then
   resolves the record and reads its status. Only an approved (or amended)
   record that nothing superseded counts. Run it as a `commit-msg` hook and as
   the authoritative CI check on the pull request. Own the inventory and the
   decision-record directory with the people who own the architecture: the
   gate checks that authority is recorded, not who recorded it.

## Maturity levels

- **Lite** — ADRs exist as numbered files from a template with consistent
  frontmatter; evolution-by-amendment is documented. Enforcement may be
  convention-only.
- **Standard** — the numbering gate runs in CI (and ideally a pre-push hook);
  ADR frontmatter is machine-validated (via M4); supersession metadata
  (`supersedes` / `superseded_by`) is required and used.
- **Strict** — pattern-checkable decisions are extracted into `adr-rules.yaml`
  and enforced by a checker in pre-commit + CI, each rule citing its ADR; the
  numbering gate is mirrored client- and server-side. Contract files
  are inventoried, and a change to one needs the inventory edit or an approved
  record, checked in CI and in a `commit-msg` hook.

## Adoption steps

1. Copy [`templates/ADR-template.md`](templates/ADR-template.md) as the
   starting point for every record under `docs/adr/`, and write the
   amendment-or-supersession rule into your conventions. This is **Lite**.
2. Run [`reference/numbering-gate/`](reference/numbering-gate/) in CI, and
   validate ADR frontmatter with
   [M4](../M4-docs-governance/)'s frontmatter checker, whose schema requires
   `decision_date`, `supersedes` and `superseded_by` for `type: adr`. This is
   **Standard**.
3. Copy [`templates/adr-rules.yaml`](templates/adr-rules.yaml), extract every
   pattern-checkable decision into it, and run
   [`reference/decisions-to-checks/`](reference/decisions-to-checks/) and its
   self-test in pre-commit and CI; run the numbering gate in a pre-push hook as
   well. This is **Strict**.
4. Copy [`templates/skeleton.yaml`](templates/skeleton.yaml) to
   `.config/skeleton.yaml` and list the files that hold your contracts; add
   the "read before modifying" line to your agent instructions (the
   [M0 template](../M0-instruction-architecture/templates/AGENTS-skeleton.md)
   has it); run
   [`reference/skeleton-gate/`](reference/skeleton-gate/) in a `commit-msg`
   hook and in CI on pull requests; and give the inventory, `docs/adr/`, the
   CI definition that runs the gate and the ownership file itself owners
   ([mappings](mappings.md#ownership-of-the-two-authority-paths)). This is
   also **Strict**.

## Status

What this module provides:

- [`templates/ADR-template.md`](templates/ADR-template.md) — the record's
  frontmatter and body, the amendment mechanism, and a worked neutral example.
- [`templates/adr-rules.yaml`](templates/adr-rules.yaml) — the rules catalog
  with one example of each rule shape (deny-on-match, require-nearby).
- [`reference/numbering-gate/`](reference/numbering-gate/) — fails when two
  ADRs share a number.
- [`reference/decisions-to-checks/`](reference/decisions-to-checks/) — a
  generic interpreter that applies the rules catalog to changed files.
- [`templates/skeleton.yaml`](templates/skeleton.yaml) and
  [`reference/skeleton-gate/`](reference/skeleton-gate/) — the skeleton
  inventory and the gate that requires an inventory edit or an approved
  decision record for a change to a listed file. The practice of keeping a
  contract set that only people change is long established where it was
  observed; this blocking gate is young, so it is the Strict rung and its
  first weeks should be read as feedback on the inventory's breadth.
- [`mappings.md`](mappings.md) (hook managers, CI providers, issue trackers)
  and the module's [maturity criteria](../../plugin/skills/audit/criteria/M5-adr-practice.yaml).

Each reference gate has a paired self-test beside it. The
[`/jig:adr`](../../plugin/skills/adr/SKILL.md) skill is the runnable
form of this practice: it writes a record, extracts its checkable rules into
the rules catalog and validates them against the interpreter's format.
[`/jig:decide`](../../plugin/skills/decide/SKILL.md) checks a new
question against the existing records first, and hands a ruling that clears
its bar to `/jig:adr`.

Deliberately left out: checking *who* approved a record or edited the
inventory (the gate reads recorded status; ownership of those two paths is the
repository's review rule, not a script); one hand-written script per rule, because a per-rule
script is what a rules catalog exists to replace; and the semantic,
model-reviewed rule tier with its routing map, which stays out until a working
repository has validated it — it belongs with the review harness
([M7](../M7-pr-lifecycle-review/)) and the learning loop
([M8](../M8-learning-loop/)). Example decisions are neutral (configuration
format, structured logging, fetch timeouts).

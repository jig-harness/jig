# M9 mappings — per-ecosystem implementations

The module [invariant](README.md) — a validated label taxonomy whose flag
labels fire process; the what/how/in-session memory tiers with a promotion path;
phase formulas whose required phases gate closure — is tool-independent. This
file maps its mechanisms onto concrete [issue trackers](../../GLOSSARY.md),
persistent-memory homes, and [CI](../../GLOSSARY.md) providers. Everything here
is an **option**, not a requirement: pick one row per column. Replace
`<placeholders>` with your values.

## The gates, per rung

| Gate | When it runs | Rung |
|------|--------------|------|
| label-taxonomy lint | on any change to `label-taxonomy.yaml` | [CI](../../GLOSSARY.md) (authority — see [M1](../M1-gates-enforcement-ladder/)); cheap enough to pre-commit too |
| required-phases | at item close/merge (or on a status transition) | CI gate, or a tracker status-automation, over the item's exported phase record |

Point one `M9` variable at wherever you vendored the module and build every path
from it; a bare `reference/...` resolves from the repo root and will not be
found. Each gate imports the shared implementation in `lib/module-gates.ts`, so
vendor the module together with `lib/`, its `vendor/` folder included (a
pinned Jig checkout keeps them in place). The label-taxonomy lint reads the
taxonomy with the js-yaml build in `lib/vendor/`.

### GitHub Actions

```yaml
# .github/workflows/tasks-memory.yml
on:
  pull_request:
    paths: ['label-taxonomy.yaml']
  # plus the close/merge check below on the merge path
jobs:
  taxonomy:
    runs-on: ubuntu-latest
    env:
      M9: modules/M9-tasks-memory        # where you vendored the module
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: bun test "$M9"/reference/label-taxonomy-lint/check-label-taxonomy.test.ts
      - run: TAXONOMY=label-taxonomy.yaml bun "$M9"/reference/label-taxonomy-lint/check-label-taxonomy.ts
  required-phases:
    runs-on: ubuntu-latest
    env:
      M9: modules/M9-tasks-memory
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: bun test "$M9"/reference/required-phases/check-formula.test.ts
      # export this PR's item phase record from the tracker (see below), then:
      - run: |
          RECORD=item-phases.txt FORMULA=phase-formula.yaml \
            bun "$M9"/reference/required-phases/check-formula.ts
```

### GitLab CI

```yaml
tasks_memory:
  variables:
    M9: modules/M9-tasks-memory
  script:
    - bun test "$M9"/reference/label-taxonomy-lint/check-label-taxonomy.test.ts
    - TAXONOMY=label-taxonomy.yaml bun "$M9"/reference/label-taxonomy-lint/check-label-taxonomy.ts
    - bun test "$M9"/reference/required-phases/check-formula.test.ts
    - RECORD=item-phases.txt FORMULA=phase-formula.yaml bun "$M9"/reference/required-phases/check-formula.ts
```

## Issue trackers — flag labels + required checks, and formula → phases

The flag label wiring has two halves: **applying** the flag (ideally derived
from the [M3](../M3-change-area-catalog/) change-area catalog, not by hand) and
**firing** its process (a required check, a blocking checklist, or an
autonomy-revoking rule). A formula's required phases map either to tracked
sub-tasks or to a status-automation that runs the [required-phases
gate](reference/required-phases/) before a transition to `done`.

| Tracker | Flag label → process | Formula phases → mechanism |
|---------|----------------------|----------------------------|
| GitHub issues | issue/PR labels; a `has-migration`/`api-change` label maps to a required status check via branch protection; a `hitl` label revokes autonomous merge (shared with [M7](../M7-pr-lifecycle-review/)) | phases as a task-list or linked sub-issues; the merge gate exports a phase record and runs the gate before allowing close |
| GitLab issues | scoped labels (`flag::has-migration`); required-check + "all threads resolved" rules per label | phases as checklist items or child issues; a pipeline job runs the gate on the merge request |
| Jira | labels or a custom field; a workflow condition/validator ties a label to a mandatory transition or a required linked review | phases as sub-tasks; a workflow validator blocks the `Done` transition until required sub-tasks resolve (or the gate passes) |
| Linear | issue labels; a `hitl` label marks a deliverable whose merge stays human; automation rules fire on label add | phases as sub-issues or a project's stage; a status-transition automation runs the gate |
| Dart | tags for flags; an automation ties a tag to a required review | phases as subtasks; a rule gates the closing transition |

Jig's [`do-item`](../../plugin/skills/do-item/SKILL.md) skill honours
the `hitl` and `manual-ops` flags on the trackers its adapter reads (Linear
today), with the label names taken from `issue_tracker.labels` in the
repository's [configuration](../../plugin/CONFIGURATION.md#issue_tracker).

The tracker-agnostic contract the gate needs is small: a `status:` and the
completed phase ids, one per line. Any tracker that can export those (a saved
view, an API query) can be gated — the export is the only per-tracker adapter.

## Issue trackers — the work-item rules

The [work-item rules](README.md#work-item-rules) need three things from a
tracker: a priority every filing path can set, a marker for the container
(the `epic` flag), and a place to record an epic's
[acceptance verdict](../../GLOSSARY.md) or waiver before it closes.

| Tracker | Priority at birth | Epic marker | Verdict or waiver before close |
|---------|-------------------|-------------|--------------------------------|
| GitHub issues | no native priority: a single-valued project field (or a `priority:` label set) written on create | an `epic` label; sub-issues for the children | a comment carrying a verdict marker line; a workflow on `issues: closed` reopens an epic without one |
| GitLab issues | scoped labels (`priority::2`, a paid tier), single-valued by construction; on the free tier, a `priority-` label set the filing path keeps to one | epics (a paid tier) or an `epic` label | a comment marker; a webhook or scheduled job reopens an epic closed without one |
| Jira | the built-in Priority field, required on create by the field configuration | the Epic issue type replaces the bug or feature type, so record the real type in a field; or keep the real type and add an `epic` label | a workflow validator on the closing transition requires the verdict field or a waiver comment |
| Linear | the built-in priority (0 none, 1 urgent to 4 low), set on create | an `epic` label, keeping the real type label | a comment marker; [`do-item`](../../plugin/skills/do-item/SKILL.md) Step 5a asks for it before extracting tails and closing |

Whatever the tracker, keep the [severity mapping](../../GLOSSARY.md) in one
committed file, and have each filing path read it or test its own copy against
it. Jig's deferral path (`resolve-review-comments`' `defer-batch.ts`) does
neither yet. Its priorities are a fixed table in the script, and its tests
compare that table with the skill's own test fixture, never with a
repository's committed mapping. So a repository that changes its mapping
changes nothing the deferral path files, and no check fails to say so: keep
the mapping at the table's values, or check the copy yourself.

The category list works the same way in Jig's tooling: it is
`review.taxonomy.categories` in `.config/jig.yaml`
([configuration reference](../../plugin/CONFIGURATION.md)), and the deferral
path checks every category it files against that list plus `unknown`. So a
finding the reviewer left uncategorized is filed as `unknown` even when the
list does not name it, and any other category outside the list is refused
before anything is written.

## Persistent-memory homes (the *how* tier + promotion)

The *what* tier is the tracker above. The *how* tier — multi-session agent
memory — and the git-tracked shared memory that promotion lands in need a
durable home. Any of these works.

| Home | Role |
|------|------|
| a git-tracked `memory/` directory | the shared, reviewable home promotion lands in; a promotion is an ordinary reviewed commit, so history and blame come free |
| agent-runtime memory feature (Claude Code / Codex / Cursor memory files, or a project `AGENTS.md`/rules file) | the *how* tier an agent reads/writes across sessions; promote the durable parts into the git-tracked `memory/` |
| a tracker comment, document or wiki page on the item or its epic | not a *how*-tier home: knowledge about one work item (its plan, decisions, handoffs) belongs to the *what* tier, on the item itself |

Promotion from private to shared memory stays [HITL](../../GLOSSARY.md) whatever
the home — the reflection/promotion *commands* live with
[M8](../M8-learning-loop/) (Jig runs promotion as the
[`promote-memory`](../../plugin/skills/promote-memory/SKILL.md) skill); M9 only
fixes where each tier's memory lives.

## CI providers

Any provider works — both gates run with Bun and TypeScript.
The only provider-specific pieces are (1) the path prefix (`M9` above) and (2)
the tracker export that produces the phase record the required-phases gate
consumes, shown per tracker above.

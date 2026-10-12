# M6 mappings — per-ecosystem implementations

The module [invariant](README.md) — named stages, each producing a named
artifact from a committed template, adversarially reviewed and de-scarred before
the next stage consumes it, with the design loop feeding back into requirements
and architecture — is tool-independent. This file maps its mechanisms onto
concrete agent runtimes, [issue trackers](../../GLOSSARY.md), doc homes, and
[CI](../../GLOSSARY.md) providers. Replace `<placeholders>` with your values.

## The two gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| Required sections | pre-commit over changed stage docs (fast, optional) | blocking on changed `docs/**` stage artifacts — the authority |
| Stage-review-record | pre-commit over changed stage docs (optional) | blocking merge gate — an artifact cannot reach `status: accepted` without a review record |

Two things these examples get right and you must not drop:

- **Run the gate scripts from the BASE, not the PR checkout.** A merge-blocking
  gate that runs scripts out of the PR's own tree is not a gate — the PR can
  edit the script. Scan the changed artifacts as *data*; run the gate scripts
  from a separately checked-out base tree (or a pinned reusable workflow).
- **Set one `M6` variable** to wherever you vendored the module and build every
  path from it; a bare `reference/...` resolves from the repo root and will not
  be found.

### GitHub Actions

```yaml
# .github/workflows/pipeline-docs.yml — runs on pull_request
on:
  pull_request:
    paths: ["docs/prd/**", "docs/architecture/**", "docs/research/**"]
jobs:
  stage-docs:
    runs-on: ubuntu-latest
    env:
      M6: base/modules/M6-feature-delivery-pipeline   # gate scripts, from the base tree
    steps:
      # The PR tree — scanned as DATA; fetch-depth 0 so we can diff the base.
      - uses: actions/checkout@<full-commit-sha> # v4
        with: { path: pr, fetch-depth: 0 }
      # The gate scripts, from the base the PR targets — the PR cannot edit them.
      - uses: actions/checkout@<full-commit-sha> # v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
      - name: Gate self-tests (blocking)
        run: |
          bun test "$M6"/reference/required-sections/check-required-sections.test.ts
          bun test "$M6"/reference/stage-review-record/check-stage-accepted.test.ts
      - name: Changed stage docs carry their required sections + a review record
        run: |
          reqsec="$M6/reference/required-sections/check-required-sections.ts"
          review="$M6/reference/stage-review-record/check-stage-accepted.ts"
          base="${{ github.event.pull_request.base.sha }}"
          git -C pr diff --name-only --diff-filter=d "$base" HEAD -- 'docs/**/*.md' |
          while read -r f; do
            # one sections manifest per artifact type, read from the base tree too
            case "$f" in
              docs/prd/*)          man="base/docs/_manifests/prd-sections.txt" ;;
              docs/architecture/*) man="base/docs/_manifests/architecture-sections.txt" ;;
              docs/research/*)     man="base/docs/_manifests/research-sections.txt" ;;
              *)                   man="" ;;
            esac
            [ -n "$man" ] && { MANIFEST="$man" bun "$reqsec" "pr/$f" || exit 1; }
            bun "$review" "pr/$f" || exit 1     # accepted-implies-reviewed, every stage doc
          done
```

### GitLab CI

```yaml
pipeline_docs:
  rules:
    - changes: ["docs/prd/**", "docs/architecture/**", "docs/research/**"]
  variables:
    # Gate scripts MUST come from the BASE the MR targets, never the MR's own
    # tree — a fork MR can edit its copy of the gate to report success. Extract
    # the base copy of the module and point M6 at THAT; the changed docs are
    # checked as data.
    M6: base/modules/M6-feature-delivery-pipeline
  before_script:
    - git fetch --depth=1 origin "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
    - mkdir -p base && git archive "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
        modules/M6-feature-delivery-pipeline docs/_manifests | tar -x -C base
  script:
    - bun test "$M6"/reference/required-sections/check-required-sections.test.ts
    - bun test "$M6"/reference/stage-review-record/check-stage-accepted.test.ts
    - |
      git diff --name-only --diff-filter=d "$CI_MERGE_REQUEST_DIFF_BASE_SHA"... -- 'docs/**/*.md' |
      while read -r f; do
        SECTIONS="$(cat base/docs/_manifests/$(basename "$(dirname "$f")")-sections.txt 2>/dev/null)" \
          bun "$M6"/reference/required-sections/check-required-sections.ts "$f" || exit 1
        bun "$M6"/reference/stage-review-record/check-stage-accepted.ts "$f" || exit 1
      done
```

The required-sections gate takes a per-artifact-type manifest (or a `SECTIONS=`
list); the stage-review-record gate takes just the artifact and passes any doc
that is not `status: accepted`, so it is safe to run over every changed stage
doc.

## Agent runtimes — the loop and the review as skills

Each stage's adversarial review is a **fresh-context** job (a new session /
subagent that has not seen the drafting), so it critiques rather than defends.
The design-prototype loop is an iterate-and-review skill over a UI surface.

| Runtime | Adversarial review | Design-prototype loop |
|---------|--------------------|-----------------------|
| Claude Code / Codex / Cursor | a review skill run in a fresh session or a spawned subagent with a red-team brief; output is findings the author clears, then de-scars | a prototype-and-critique skill: generate a UI, review it against the PRD's user goals, iterate; feed product findings back to the PRD/architecture |
| Any agent runtime | new conversation per review so context does not anchor; the reviewer sees only the artifact + the stage brief | render → review → revise; import the accepted prototype in a standard component form, then re-check the architecture |
| Humans | a reviewer other than the author reads the artifact cold | design critique with product + engineering present |

The fresh-context rule is the portable part; which runtime hosts it is a local
choice. Model routing and named critique personas are deliberately not
prescribed here. For the design loop's brief, the
[`/jig:design-brief-builder`](../../plugin/skills/design-brief-builder/SKILL.md)
skill assembles and audits the bundle an external design session receives.

## Issue trackers — epic decomposition + flag labels

Epic decomposition is the handoff: accepted artifacts become an epic of
sub-issues, each carrying a plan and the [flag labels](../../GLOSSARY.md) that
drive downstream gates. The label taxonomy is [M9](../M9-tasks-memory/)'s;
[M3](../M3-change-area-catalog/) maps labels/paths to the gates they fire.

| Tracker | Epic + sub-issues | Flag labels |
|---------|-------------------|-------------|
| GitHub / GitLab issues | an epic issue with a task list linking child issues | labels like `has-migration`, `api-change`, `ui`, `hitl`; a PR inherits them and required checks/reviews follow |
| Linear / Jira | a parent/epic with sub-issues and a per-issue plan | labels drive automation rules; `hitl` marks a deliverable whose merge stays human |
| Beads / a markdown plan | an epic file with checkbox sub-tasks | a label column per task, read by the change-area projection |

The flag labels are what connect this module to delivery: they are set at epic
decomposition and consumed by [M7](../M7-pr-lifecycle-review/)'s review
selection, so a `has-migration` sub-issue pulls in the migration review when its
pull request opens.

## Doc / template homes

| Artifact | Template | Typical home |
|----------|----------|--------------|
| Research note | [`research-note-template.md`](templates/research-note-template.md) | `docs/research/<date>-<slug>.md` |
| PRD | [`prd-template.md`](templates/prd-template.md) | `docs/prd/<feature>.md` |
| Architecture | [`architecture-template.md`](templates/architecture-template.md) | `docs/architecture/<feature>.md` |
| Decision | (an ADR — see [M5](../M5-adr-practice/)) | `docs/adr/ADR-NNNN-<slug>.md` |

Where the docs tree is schema-validated ([M4](../M4-docs-governance/)), one
frontmatter block can serve both docs governance and the two M6 gates, but
the two vocabularies need joining first. The stage templates carry only what
the M6 gates read (`status`, `reviewed`), and M4's schema template knows
neither `accepted` (a `status` value) nor `research-note` (a `type` value).
Add those values to your schema, and add the schema's required fields
(`lifecycle`, `owner`, `last_updated`, `tags`) to your copies of the stage
templates.

## CI providers

Any provider works — both gates use Bun and TypeScript with self-tests. The only
provider-specific piece is the changed-files query (`git diff --name-only`
against the merge base), shown above for GitHub Actions and GitLab CI. Run the
required-sections gate on **changed stage docs** and the stage-review-record
gate as a **merge gate**; [CI](../../GLOSSARY.md) is the authority (see
[M1](../M1-gates-enforcement-ladder/)).

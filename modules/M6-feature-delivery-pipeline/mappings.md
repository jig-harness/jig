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
          # -z: file names verbatim; a file, not a pipe, so a failing git diff stops the step
          list=$(mktemp)
          git -C pr diff -z --name-only --diff-filter=d "$base" HEAD -- 'docs/*.md' > "$list"
          while IFS= read -r -d '' f; do
            # one sections manifest per artifact type, read from the base tree too
            case "$f" in
              docs/prd/*)          man="base/docs/_manifests/prd-sections.txt" ;;
              docs/architecture/*) man="base/docs/_manifests/architecture-sections.txt" ;;
              docs/research/*)     man="base/docs/_manifests/research-sections.txt" ;;
              *)                   man="" ;;     # not a stage artifact: no sections to require
            esac
            [ -n "$man" ] && { MANIFEST="$man" bun "$reqsec" "pr/$f" || exit 1; }
            bun "$review" "pr/$f" || exit 1     # accepted-implies-reviewed, every changed doc
          done < "$list"
```

### GitLab CI

```yaml
pipeline_docs:
  # Merge-request pipelines only: CI_MERGE_REQUEST_DIFF_BASE_SHA is empty in
  # any other pipeline, and both the base tree and the diff need it.
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes: ["docs/prd/**", "docs/architecture/**", "docs/research/**"]
  variables: { GIT_DEPTH: 0 }   # full history: the merge base must be present
  image: <an image with bun and bash>
  before_script:
    # Gate scripts MUST come from the BASE the MR targets, never the MR's own
    # tree — a fork MR can edit its copy of the gate to report success. Extract
    # the base copy of the module, with the lib/ it imports, into a fresh
    # directory outside the checkout and point M6 at THAT; the changed docs are
    # checked as data.
    - git fetch origin "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
    - export BASE_TREE="$(mktemp -d)"
    - git archive "$CI_MERGE_REQUEST_DIFF_BASE_SHA" lib
        modules/M6-feature-delivery-pipeline docs/_manifests | tar -x -C "$BASE_TREE"
    - export M6="$BASE_TREE/modules/M6-feature-delivery-pipeline"
  script:
    - bun test "$M6"/reference/required-sections/check-required-sections.test.ts
    - bun test "$M6"/reference/stage-review-record/check-stage-accepted.test.ts
    - |
      [ -n "${BASH_VERSION:-}" ] || { echo "pipeline_docs needs bash" >&2; exit 1; }
      list=$(mktemp)
      git diff -z --name-only --diff-filter=d "$CI_MERGE_REQUEST_DIFF_BASE_SHA"... -- 'docs/*.md' > "$list"
      while IFS= read -r -d '' f; do
        case "$f" in
          docs/prd/*)          man="$BASE_TREE/docs/_manifests/prd-sections.txt" ;;
          docs/architecture/*) man="$BASE_TREE/docs/_manifests/architecture-sections.txt" ;;
          docs/research/*)     man="$BASE_TREE/docs/_manifests/research-sections.txt" ;;
          *)                   man="" ;;     # not a stage artifact: no sections to require
        esac
        [ -n "$man" ] && { MANIFEST="$man" bun "$M6"/reference/required-sections/check-required-sections.ts "$f" || exit 1; }
        bun "$M6"/reference/stage-review-record/check-stage-accepted.ts "$f" || exit 1
      done < "$list"
```

File names come from `git diff -z`, which prints them verbatim, each ended by
a zero byte; without it git quotes a name holding a double quote, a backslash,
a control character such as a newline, or (under the default
`core.quotePath`) a non-ASCII character, and the quoted form names no file.
The list goes through a file rather than a pipe, so a failing `git diff`
stops the step instead of reading as an empty list, and the loop runs in the
shell itself, so `exit 1` fails the step. The pathspec is `'docs/*.md'`: in a
git pathspec `*` crosses `/`, so it matches every depth, while
`'docs/**/*.md'` misses the documents directly under `docs/`. `read -d ''`
needs bash: GitHub Actions runs `run:` steps with bash on Linux, and the GitLab
job names a bash image and fails under any other shell rather than reading an
empty list.

The GitLab job extracts `lib/` with the module because the gate scripts import
`../../../../lib/module-gates.ts`, so the base tree keeps Jig's layout:
`modules/M6-feature-delivery-pipeline/` beside `lib/`.

A document directly under `docs/` is not a stage artifact, so it has no sections
manifest and the required-sections gate skips it (the gate refuses to run
without a list of sections). The stage-review-record gate still reads it: it
takes just the artifact and passes any well-formed doc that is not
`status: accepted` (unclosed frontmatter or a duplicated `status:` or
`reviewed:` key fails it whatever the status), so it is safe to run over every
changed doc, and a top-level doc marked accepted
without a review record still fails. The job's trigger lists only the stage
directories, so such a doc is read when the same change also touches a stage
artifact; list `docs/**` there to read it on every change.

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
prescribed here. For the requirements and architecture stages, the
[`/jig:red-team`](../../plugin/skills/red-team/SKILL.md) skill runs the
review by persona, each persona in its own subagent or fresh agent run, and
writes the findings to one report; its personas are one set of choices, kept
in the skill. For the design loop's brief, the
[`/jig:design-brief-builder`](../../plugin/skills/design-brief-builder/SKILL.md)
skill assembles and audits the bundle an external design session receives,
then merges and checks the returned bundle before it is accepted.

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

## The lifecycle map

The [lifecycle map](templates/LIFECYCLE.md) names an owner per stage, and the
[lifecycle map gate](reference/lifecycle-map/README.md) resolves each owner
against the places a repository keeps what it names. The owner is written as
a code span, so the gate can read it.

| Owner is | Written as | Resolved against |
|----------|------------|------------------|
| A skill in a plugin | `/<plugin>:<skill>`, such as the Jig plugin's `/jig:file-issue` | `--skills <plugin>=<dir>`: `<dir>/<skill>/SKILL.md`, the plugin's `skills/` directory |
| A repository's own skill or command | `/<name>` | `--skills <dir>`, one entry per directory: `.claude/skills/<name>/SKILL.md` and `.claude/commands/<name>.md`; the [skills mirror](../M0-instruction-architecture/mappings.md#cross-runtime-skill-discovery-the-symlink-mirror) makes the same directory serve Codex, so one entry covers both runtimes |
| A package script | `bun run <script>`, `npm run <script>`, `pnpm run <script>`, `yarn run <script>` | `scripts` in `package.json` (`--package-json`) |
| A script in the repository | `bun <path>` or `<path>` | the file, under `--root` |
| A tool outside the repository | `gh`, `make deploy` | only when declared: `--external gh` |
| A document, or a person | a link | the file the link reaches, relative to the map |

A runtime with no skill directory the gate can read (a hosted agent whose
skills live in its service) names those stages' owners as a document that
says how the stage is run, and links it.

```yaml
# .github/workflows/gates.yml — steps beside the other documentation checks
- name: Lifecycle map gate self-test (blocking)
  run: bun test "$GITHUB_WORKSPACE/$M6"/reference/lifecycle-map/check-lifecycle-map.test.ts
- name: The lifecycle map names only owners that exist
  working-directory: pr   # the change's tree, read as data
  run: >-
    bun "$GITHUB_WORKSPACE/$M6"/reference/lifecycle-map/check-lifecycle-map.ts docs/LIFECYCLE.md
    --skills <plugin>=<plugin-dir>/skills --skills .claude/skills
    --skills .claude/commands --cover <plugin-dir>/skills --linked-from AGENTS.md
```

As with the other gates, run the script from the base the change targets
(the `M6` variable above, under `base/`), never from the change's own tree,
and read the map and the skill directories as data from `pr/`, the step's
working directory and so the gate's `--root`; a change that rewrites the gate cannot then
report itself clean. `--cover` is for a repository that ships skills and
wants none left off the map: one entry per directory it ships from, so a
repository whose own skills under `.claude/skills` belong on the map adds
`--cover .claude/skills` too. A repository that only uses a plugin leaves it
out.

## CI providers

Any provider works — the gates use Bun and TypeScript with self-tests. The only
provider-specific piece is the changed-files query (`git diff --name-only`
against the merge base), shown above for GitHub Actions and GitLab CI. Run the
required-sections gate on **changed stage docs** and the stage-review-record
gate as a **merge gate**, and the lifecycle map gate with the other documentation checks; [CI](../../GLOSSARY.md) is the authority (see
[M1](../M1-gates-enforcement-ladder/)).

# The spec a work item links: design

**What problem this solves.** A work item in Jig carries or links whatever
requirements it has, and that fits a repository that writes a four-document
spec per feature as well as one that writes three lines in an issue. But the
link is prose: `do-item` hands the implementing agent the body and its
comments, the reviewer is told to check "the acceptance criteria" wherever
they may be, and the pull request never says which were met. A feature with
no requirements is picked up like one with them. With this built, the
skills resolve what an item links into requirements, acceptance criteria
and tasks with their ids, in whatever framework the repository keeps them,
hand them to the agent and the reviewer, and the pull request closes with
each criterion met with evidence, deferred to a filed item, or not
applicable. The delivery loop writes no spec and dictates no format.

This is the design of [plan.md](plan.md) item 29, following the
[spec ecosystems research note](spec-ecosystems-research.md). Nothing of it
is built. The stance it keeps is M6's: the item is the unit of work, and
what the item links is the repository's own.

## The rule

> A work item **names where its requirements and acceptance criteria live**:
> in its own body, or by a path or link to an artifact in the repository or
> the tracker. Jig **resolves** that reference, read-only, through an adapter
> per layout, into a list with stable ids, and **never writes** the artifact.
> The implementing agent and the reviewer get the list; the pull request
> **accounts for every acceptance criterion**: met, with the evidence record
> that shows it; deferred, with the tracker item that carries it; or not
> applicable, with a sentence. An item whose work type requires requirements
> and links none stops, saying so, before any code is written.

## How it works

### The resolver

`plugin/shared/spec/resolve.ts` takes the issue JSON that `get_issue.ts`
returns and the repository root, and prints one result:

```json
{
  "sources": [
    {"adapter": "openspec", "ref": "openspec/changes/add-export/", "evidence": ["body link", "convention"]},
    {"adapter": "body", "ref": "#body/Acceptance criteria", "evidence": ["section"]}
  ],
  "requirements": [{"id": "export-csv", "key": "openspec/changes/add-export/#export-csv", "text": "…", "source": 0}],
  "acceptance": [{"id": "AC-1", "key": "openspec/changes/add-export/#AC-1", "text": "…", "requirement": "openspec/changes/add-export/#export-csv", "source": 0}],
  "tasks": [{"id": "1.2", "key": "openspec/changes/add-export/#1.2", "text": "…", "done": false, "source": 0}],
  "unresolved": ["https://…/design-doc (no adapter)"]
}
```

It finds references in the following places, in this order, and keeps
every one it finds rather than the first:

1. **The body.** A section whose heading the configuration names
   (`## Spec` by default, `## Requirements` and `## Acceptance criteria`
   recognised as inline sources), and any path or link in the body that an
   adapter claims.
2. **The repository, by convention.** Each adapter knows its layout and
   looks for a folder or file named by the issue key, its slug or its
   branch: `openspec/changes/<id>/`, `specs/<nnn>-<slug>/`,
   `.kiro/specs/<slug>/`, `conductor/tracks/<slug>_<date>/`,
   `docs/superpowers/{specs,plans}/<date>-<slug>*.md`,
   `agent-os/specs/<date>-<slug>/`, a plan whose frontmatter carries an
   artifact contract, a `tickets.toml` entry whose id is the issue key, a
   `specs/*.spec.md` whose `targets` cover the files the item names.
   Detection is derive-before-declare ([dispositions](../docs/dispositions.md)):
   a layout present in the repository turns its adapter on, and
   `specs.adapters` only orders or restricts them.
3. **The tracker.** Documents and attachments the adapter exposes on the
   issue, when the tracker interface gains the attachment operation
   ([the plan](plan.md), item 12).

Keeping every reference needs the rules below, so that one line cannot
discharge two criteria and one criterion is not counted twice:

- **One source per artifact.** A source is identified by its canonical
  path in the repository (or its tracker id), so the same spec found
  through a body link and through the convention scan is one source, with
  both findings in its `evidence` list.
- **Keys qualified by their source.** Every requirement, criterion and task
  carries a `key`: its source's canonical reference and its local id
  (`openspec/changes/add-export/#AC-1`), and a criterion names the
  requirement it serves by that requirement's key. Two specs that both
  number an `AC-1` give two keys. The pull-request section, the reviewer's list and a
  thread that cites a criterion use the key; the short id is shown alone
  only where it is unique in the result.

**Reads stay inside the repository.** A reference comes from an issue body,
which anyone who can write an issue controls, and what the resolver reads
reaches the implementing agent's and the reviewer's prompts. Before reading,
the resolver resolves a reference's real path and reads it only when that
path is inside the repository root and an adapter's layout claims it: each
adapter declares the path patterns its artifacts take (`openspec/changes/*/`,
`specs/*.spec.md`, Markdown and its own manifest files under its folder),
and a path no adapter's patterns match, or one Git ignores, is not read. So
an absolute path, a `..` that leaves the root, a symbolic link whose target
is outside it, and an in-repository file such as `.env` all go into
`unresolved` with the reason. The conformance test every adapter passes
includes these refusals, checked before any read. A link to a web page is never fetched by
the resolver. A tracker document is read through the tracker interface,
by the id the tracker lists among this issue's own documents and
attachments, never by fetching a URL taken from the body: a link in the
body that names a tracker document counts only when that id is in the
issue's list, and is otherwise `unresolved`. The read runs with the
tracker interface's credentials against the configured tracker alone, so
an issue cannot point the resolver at another host or at a document the
issue does not carry.

Each adapter reads the tool's own machine-readable surface where it has one
(OpenSpec's `show` with its machine-readable flag, cc-sdd's `spec.json`,
GSD's and Compound Engineering's frontmatter, BMAD's index, Tessl's
frontmatter) and falls back to the text's own id conventions (`FR-001`,
`_Requirements: 1.1_`, `### Requirement:` headings, numbered task
checkboxes). An adapter is a read-only function from a reference to the
three lists; the family lives in `plugin/shared/spec/adapters/`, one file
each, with a fixture folder per layout and a conformance test every adapter
passes. The `body` adapter is the one every repository has.

### Where the result is used

- **`do-item`**, after it fetches the issue, runs the resolver for every
  type in `specs.require_for_types`, whatever that type's pre-scouts say,
  and for any other type whose row names the `spec` pre-scout
  ([work types](work-types.md)), where the result is context and its
  absence stops nothing. For a required type, requirements are present
  only when the resolution is complete and yields at least one acceptance
  criterion. Complete means every source the item references resolved: one
  its adapter cannot parse, or a link that leads nowhere, leaves the
  resolution partial even when another source supplies criteria, since the
  unread source's criteria would go unaccounted for. A source that yields
  only requirements or tasks, an empty result and a partial resolution all
  count as none, and the item stops before any code is written. In an
  interactive session it asks one question: proceed without requirements
  (for a partial resolution, without the unread sources), or point at
  them. Proceeding is an explicit exception, and the author cannot grant
  it alone: the person who decides applies `specs.exception_label` to the
  item, and an exception counts only when the forge's or tracker's own
  label event names an actor other than the pull request's author and the
  identity the implementing agent runs as. Before it asks, `do-item`
  writes the exception record to the item as one comment: the item's
  references, each source's revision (the last commit to touch its path
  for a repository file, the forge's or tracker's own last-edited time
  for a document or an issue, or, for a source that could not be read,
  `unread` with what the read returned: not found, no access, or a
  layout no adapter parses), and the lines the pull request's
  `## Acceptance` section will carry: one `unresolved` line per unread
  source, or, when the item has no source at all or its sources yield no
  criterion, one `exception` line for the item, each with its reason. The
  approval covers that record, and only while it stands: the label must
  still be on the item, its latest application must come after the
  record's last edit, the item's references and every source's revision
  must still match the record. A source the record lists as `unread`
  matches while the same read still returns the same answer; once it
  reads, or fails differently, it has changed. A source the record gives a
  revision for has changed when its revision can no longer be read. The
  section's `unresolved` and `exception` lines must be
  the record's lines. A line of either kind that no standing approval
  covers accounts for nothing. A source added or edited after the record,
  or a line the record does not carry, needs a new record and a fresh
  application of the label by an eligible actor, and a removed label
  approves nothing. The section is written after the approval, from the
  record, so writing it never outdates the approval. With nobody to answer, it stops and states the gap, as
  [plugin/AGENTS.md](../plugin/AGENTS.md) requires of a question nobody can
  answer, and leaves the item for a person; a repository that wants
  features without requirements picked up unattended says so beforehand by
  leaving `feature` out of `specs.require_for_types`. The delegation prompt carries the requirements and
  acceptance criteria by id, and the Tier 3 reviewer gets the same list
  instead of the sentence it gets today.
- **The pull-request body** gains an `## Acceptance` section the skill
  writes from the result: one line per criterion, with its state and its
  evidence record ([verify and debug](verify-and-debug.md)), deferred
  items filed through `issue_tracker.file_command` and linked, and `not
  applicable` with a reason. `pr-plan.ts open` refuses (its policy exit
  `3`) a body whose section leaves a criterion unaccounted for when the
  work type requires requirements.
- **`drive-pr`** treats the section as the pull request's own: a reviewer
  thread that cites a criterion id is resolved against it, and a criterion
  the drive finds changed to `met` without a record is a finding for the
  author, not a certification.
- **`review`** in plan mode checks a plan against the criteria of the spec
  the plan names, so a plan that drops a requirement is caught before the
  epic is filed.
- **`file-issue`** writes the `## Spec` section when the discussion names
  an artifact, so an item Jig files always resolves.
- **`/followup`** after the merge offers the framework's own post-ship
  step where the adapter has one (OpenSpec's archive, a converge or sync
  command) and runs none of them unasked.
- **The epic close** cites the criteria in the acceptance verdict
  ([M9](../modules/M9-tasks-memory/README.md#an-epic-closes-on-an-accepted-verdict)),
  so "designed scope is delivered" has a list behind it.

### Writing specs

Jig recommends, with credit, the tools that write specs well in
[RECOMMENDED-SKILLS.md](../plugin/RECOMMENDED-SKILLS.md), each with the
adapter that reads what it writes, and keeps M6's templates for the
repository that wants a layout of its own; the kickoff family
([the plan](plan.md), item 3) merges them into one of each and writes a new
project's first requirements and architecture documents from them, as one
layout the resolver reads. No skill in the delivery loop writes a spec or
rewrites one a repository already keeps.

### The audit

M6's criteria gain one at Standard: work of a required type is not picked
up without acceptance criteria. Its rungs follow the
[criteria ladder](../plugin/skills/audit/criteria/README.md). The
`convention` observation is the policy: `specs.require_for_types` is set,
or left at its default, and the instructions say where an item's
requirements go. `do-item`'s stop above and `pr-plan.ts`'s refusal run
only where those helpers are used: a person who picks an item up by hand or
opens a pull request directly passes neither, so on their own they score
`advisory`. The `mechanical` observation is enforcement on every change: a
required check on the pull request reads its linked item's type and refuses
a pull request that links no item, since its type is then `unknown` and
takes the strictest row, and one of a required type whose `## Acceptance` section accounts
for no criterion, or leaves one unaccounted for, unless the exception is
recorded as `do-item`'s step above requires: the reason in the section,
and the label applied by someone other than both the pull request's author
and the identity the implementing agent runs as, still applied, applied
after the exception record's last edit, with the item's references and its
sources' revisions still as the record states them and the section's
exception lines equal to the record's. The check counts as
enforcement only when nothing it decides with comes from the pull request
it judges ([M7](../modules/M7-pr-lifecycle-review/README.md), invariant
8): its workflow and script, `specs.require_for_types`, the type mapping
and the exception label are read from the target base branch or a pinned
version, never from the head. A pull request that changes any of them is
judged by the base's copy, and the proposed change takes effect once it
merges. The head's copy may run only in a separate, unprivileged shadow
job with no secrets and a read-only token, never in the job that decides,
and reports what it would decide as a comment that decides nothing
(M7, invariants 8 and 9). The audit reports the
share of such exceptions beside the score, so work that went ahead
without criteria is visible rather than counted as enforced. It also reports,
as evidence and not as the score, the share of items from the last 30 days
typed as a required type that resolve completely to at least one criterion, and the
recommendation names the adapter the repository's layout would turn on.

## Configuration

| Field | Type | Default | Read by |
|---|---|---|---|
| `specs.adapters` | list of adapter names, in order | every adapter whose layout is present, then `body` | do-item, review, file-issue, followup |
| `specs.body_section` | heading text | `Spec` | do-item, file-issue |
| `specs.require_for_types` | list of work types | `[feature]` | do-item |
| `specs.deferral_label` | label | `issue_tracker.labels.followup` | do-item |
| `specs.exception_label` | label | `spec-exception` | do-item, the required check |

## Build order

1. **The resolver and the `body` adapter**, with the conformance test and
   the pull-request section; `do-item` prints the result and changes
   nothing else.
2. **The repository adapters**, one pull request per two or three layouts,
   each with its fixture folder; the audit criterion with the last of them.
3. **`do-item` reads and requires**: the pre-scout, the delegation prompt,
   the reviewer's list, the policy refusal, the recommended-skills page.
4. **The required check**: a portable script that reads the linked item's
   type and the `## Acceptance` section and refuses as the audit's
   `mechanical` rung describes, including the exception label's actor,
   that it is still applied and that it postdates the exception's lines;
   its tests; a workflow template that runs the script and reads the
   policy from the base branch, never the head, and the setup step that
   makes it a required check on the base branch. Until a repository installs it, the
   criterion scores `advisory` there.
5. **`review`, `file-issue`, `followup`, the epic close.**
6. **The tracker source**, once the tracker interface has attachments.

## Left out

- **A spec format the resolver requires, or a skill in the delivery loop
  that writes specs.** The research note says why; M6's templates, and the
  kickoff skill that writes from them, stay one layout among the ones the
  resolver reads.
- **A stakeholder sign-off record.** Whether an approval by someone who
  reads no pull requests belongs in Jig is not settled; nothing here
  depends on it, and the acceptance section is readable by that person
  when it is.
- **A hosted page for the requirements.** The artifact lives where the
  repository keeps it; the tracker shows status.
- **Running a framework's archive or sync step.** Offered after the merge,
  never run unasked: each one rewrites the repository's specs.
- **Writing the result back into the spec.** Marking a task done in
  someone else's `tasks.md` is that tool's job; the pull request is Jig's
  record.

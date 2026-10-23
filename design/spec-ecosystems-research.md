---
title: "How should Jig relate to spec-driven frameworks? — research note"
type: research-note
status: draft
date: 2026-10-23
---

# Research note: how should Jig relate to spec-driven frameworks?

## Question

Should Jig add a stage that checks shipped work against a product document
of its own, as several workflow frameworks now do, or keep its stance that a
work item carries or links whatever requirements it has, and make that link
something the skills can resolve and check? The answer decides the `spec`
pre-scout in [work types](work-types.md), the shape of the
[spec link design](spec-link.md), and what the website's comparison page
([website design, build order](website.md#build-order)) compares on.

## Context

Jig's [M6](../modules/M6-feature-delivery-pipeline/README.md) names the
pipeline's stages and ships a [PRD](../GLOSSARY.md) and an architecture
template, but nothing downstream reads them: `do-item` hands the
implementing agent the issue body and its comments, and the Tier 3 reviewer
gets "the issue description and acceptance criteria", wherever they are. That
has been a strength. A repository with a heavy spec practice and one that
writes three lines in an issue both work, because Jig assumes the item
includes or links what the work needs. The question is whether the link can
become a resolvable, checkable fact without Jig dictating the form of what
it points to.

The landscape was read on the date above from each project's own
repository and documentation; versions and counts are of that day. The
profiles behind the table are in the session that wrote this note; the
table keeps what decides the question.

## Options considered

### Option A: a product document and check of Jig's own

- **How it works:** a Jig-owned requirements document per feature with
  numbered outcomes, a reviewer set that reads it as a non-engineer would,
  and a stage after code review that marks each outcome verified or
  deferred.
- **Pros:** one format every skill understands; the outcome check is
  precise; stakeholders get one page.
- **Cons / risks:** a second spec in every repository that already has one;
  a format Jig would have to maintain against a crowded field; the lightest
  items pay for a document they do not need; the stakeholder page in the
  frameworks that have it is bound to one vendor's hosted artifact.

### Option B: resolve the link, check against what it finds

- **How it works:** a work item names where its requirements and acceptance
  criteria live, inline or by reference; a read-only resolver recognises the
  layouts and machine-readable surfaces of the common frameworks and the
  item's own body, and returns requirements, acceptance criteria and tasks
  with their ids; the skills hand that to the implementing agent and the
  reviewer, and the pull request says which criteria were met, with
  evidence, and which were deferred. Jig writes no spec.
- **Pros:** keeps the stance that fits both heavy and light repositories;
  rides each framework's own validator and living-spec step; one adapter per
  layout, like the tracker adapters.
- **Cons / risks:** quality depends on the linked artifact; a body with no
  link and no criteria gets no check beyond "none found"; adapters track
  moving targets.

### Option C: leave it as it is

- **How it works:** the agent reads the body and whatever it links.
- **Pros:** nothing to build.
- **Cons / risks:** "acceptance criteria" stays a phrase, never a list the
  pull request can be checked against; a feature with no requirements is
  picked up like one with them.

## Evidence

### The landscape

Structure is how much form the tool imposes, from 1 (free text and links)
to 5 (a fixed tree of validated documents).

| Project | Unit of work | Where its spec lives | What another tool can read | Tracker | After merge | Structure |
|---|---|---|---|---|---|---|
| OpenSpec | a change | `openspec/changes/<id>/{proposal,design,tasks}.md` with delta specs per capability; main specs in `openspec/specs/<capability>/spec.md` | `openspec show`, `status`, `validate`, `instructions`, all with a machine-readable flag; a schema for the artifact graph | none | archive merges the deltas into the main specs | 4 |
| Spec Kit | a feature | `specs/<nnn-name>/{spec,plan,research,data-model,tasks}.md`, `.specify/memory/constitution.md`, state in `.specify/feature.json` | requirement, success-criterion, story and task ids in the text; a version command and a feature-creation script with machine-readable output | GitHub Issues through an opt-in extension | a converge step reconciles code to spec; no merge-back | 4 |
| Kiro specs | a feature or a bug | `.kiro/specs/<name>/{requirements,design,tasks}.md`, steering files | numbered requirements cited from tasks; nothing else | not found | none; edit and regenerate | 4 |
| cc-sdd | a feature spec, with a discovery brief | the Kiro layout plus `spec.json` with approval state per phase | `spec.json` | none | none | 4 |
| Tessl | a spec per set of target files | `specs/*.spec.md` with `targets` in frontmatter and test links | the frontmatter, a verify configuration in `tessl.json`, verifier output as machine-readable report | none | the spec stays authoritative for its files | 2 |
| Conductor | a track | `conductor/tracks/<id>/{spec,plan}.md`, `metadata.json`, a checkbox registry | `metadata.json`, the registry | none | product and stack documents re-synced | 4 |
| Superpowers | a change or project | `docs/superpowers/specs/<date>-<topic>-design.md` and `plans/<date>-<feature>.md` | file names and a `Spec:` line in the plan | none | none | 3 |
| Compound Engineering | a feature or bug, one plan | `docs/plans/*.md` with a versioned artifact contract in frontmatter; `docs/solutions/` for lessons | validated frontmatter, requirement and unit ids in the text, a pipeline mode with machine-readable status | GitHub pull requests only | lessons compound into `solutions/`; the plan has no status by design | 4 |
| GSD Core | milestone, phase, plan, task | `.planning/{PROJECT,ROADMAP,REQUIREMENTS,STATE}.md`, `phases/<nn>-<slug>/<nn>-<pp>-PLAN.md` | schema-validated frontmatter on plans and state, requirement ids, gate predicates with machine-readable results | GitHub through the command line; an optional tracker id per task | `STATE.md` and `REQUIREMENTS.md` kept current; a learnings file | 5 |
| gstack | a sprint per feature | design and plan documents under a per-user state root, outside the repository | a timeline and evidence receipts bound to a working-tree hash | GitHub Issues | retro and learn steps, per machine | 3 |
| BMAD-Method | trivial change up to project | `_bmad-output/` with initiative, epic and story documents and a `tickets.toml` index with stable ids and dependencies | the index, plan-file status, review findings as machine-readable output, a tickets script | GitHub Issues, Jira, Linear, Notion, Trello, synced when a skill runs | the spec is replanned in place; a retrospective | 5, scaling down |
| Agent OS | a feature spec plus repository standards | `agent-os/specs/<date>-<slug>/{plan,shape,references,standards}.md`, `agent-os/standards/` with an index | the standards index, the dated folder name | none | standards re-discovered from code | 2 |
| Traycer | a task holding tickets | artifacts in the application, mirrored to a per-user folder while open | an `index.md` with frontmatter per artifact, command-line output as machine-readable lines | GitHub Issues, through a retired path | none in the repository | 3 |
| pro-workflow | a session | none; a learnings database and handoff notes per user | nothing that finds a plan for a given item | none | learnings re-injected at session start | 2 |
| MetaSpec | a generated toolkit | the Spec Kit layout inside a generated kit | a generated validator for the domain format | none | proposal, apply and archive commands | 4 |
| The namesake Jig at jig.fyi | a ticket typed bug, feature, improvement or task | `docs/plans/<date>-<topic>-<kind>.md` with kinds prd, spec and plan; an optional live page on one vendor's hosted artifact | a Markdown configuration with embedded blocks; acceptance items traced to outcome ids | Linear, Jira, GitHub Issues as configuration keys | a check of each outcome after review; a learning loop | 4 |
| Arazzo | an API call sequence | one document beside the API description | all of it: a schema, runners that evaluate success criteria | none; extension fields | versioned | 5 for its domain |
| A published essay on writing specs for agents | a feature or module | `SPEC.md` per module, `tasks/plan.md` | file names | "or an external tracker" | update the spec, commit it, cite it in pull requests | 2 |
| A published playbook for an agent-native delivery cycle | an intent | `intent/intent.md`, `spec.md`, `plan.md`, evals, a review file | file names | record id in the artifact, commit in the record | incidents become evals and lessons | 3 |

### What the table shows

| Question | What the evidence shows | Source |
|---|---|---|
| Is there a format to standardise on? | No. Seven distinct layouts are in active use, two tools have changed their unit of work in the last year, and the Kiro three-file layout is the only one others copy. | the table |
| What do they agree on? | Requirements get stable ids; tasks cite them; the artifact lives in the repository, in a folder named by the unit of work, with the id in the path. The two documents written for the field rather than as tools say the same: cite the record id in the artifact, keep the commit in the record. | OpenSpec, Spec Kit, Kiro, cc-sdd, GSD Core, BMAD-Method, Compound Engineering; the essay and the playbook |
| Can another tool find "the spec for this item"? | Only where the tool has a machine-readable surface: OpenSpec's commands, `spec.json`, GSD's and Compound Engineering's frontmatter, BMAD's index, Tessl's `targets`. For the rest, the path convention is the surface. | the "what another tool can read" column |
| Who talks to a tracker? | Almost nobody beyond GitHub through the command line. Two tools bind to Linear and Jira by configuration. Jig's tracker interface is already ahead here. | the tracker column |
| Who checks shipped work against the spec? | Three: a converge step, an outcome check after review, and OpenSpec's archive that merges deltas. None of them is a document a second tool could check; each is a prompt in its own pipeline. | Spec Kit, the namesake Jig, OpenSpec |
| Where does the stakeholder page live? | In the one tool that has it, on a vendor's hosted artifact. Everyone else keeps requirements in the repository and status in the tracker. | the namesake Jig |
| What is the trend? | Towards less process inside the tool: one framework removed its verification stages across two major versions, one retired its planning extension, one never shipped its spec-as-source product. The ones growing are the ones with a validator and a machine-readable surface. | Agent OS, Traycer, Tessl; OpenSpec, GSD Core, Spec Kit |

## Recommendation

- **Recommendation:** Option B, because the field agrees on the linkage and
  on nothing else. A resolver that reads the common layouts and the item's
  own body turns "acceptance criteria" into a list the pull request is
  checked against, in whatever form the repository already keeps it, and
  Jig stays the delivery loop under any spec practice rather than one more
  spec format. The outcome check Option A wanted becomes a section of the
  pull request body: each criterion met with evidence, deferred with a
  tracker item, or not applicable, which is a stronger artifact than a
  prompt because the drive and a person can both read it.
- **Revisit if:** the layouts converge on one machine-readable surface
  (then one adapter replaces the family), or a consumer repository shows
  that the linked artifacts are too weak to check against and asks for a
  template (then M6's templates, merged into the kickoff family, are the
  answer, still as one layout the resolver reads).
- **Still unknown:** how often a work item in a consumer repository links
  nothing at all, which decides how hard the `spec` pre-scout should push;
  whether a stakeholder sign-off belongs anywhere in Jig, which this note
  does not settle and the design leaves out.

## Decision graduation

- **Decision recorded as:** informational. The stance it confirms (a work
  item carries or links its requirements; Jig dictates no spec format) is
  worth a decision record when the [spec link design](spec-link.md) ships,
  since it settles what Jig will not build.

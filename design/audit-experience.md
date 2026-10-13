# The audit experience: design

**What problem this solves.** `/jig:audit` scores a repository well, but a
result that reaches people only as a Markdown report and a YAML record works
for the agent that wrote it. It does not work as well for the team deciding what to
do next. On a first audit especially, the team needs to see what was examined,
how mature the repository is against the profile it wants, which few moves
matter most, and a quick way to accept, decline or adjust each
recommendation. Without that, adoption depends on someone reading a long
report and turning it into instructions by hand, and declined recommendations
come back on every re-run because nobody recorded them. With it, the audit
ends in a polished report the team can share. The team marks its decisions in
that report and copies them to an agent, which records the declines and starts
the accepted work.

This is the design of [ROADMAP.md](../ROADMAP.md) item 8. Most of it is
built, and the [audit skill](../plugin/skills/audit/README.md) documents what
is: the audit sheet and its report source
([report-sheet.md](../plugin/skills/audit/references/report-sheet.md)), the
decisions round trip, profiles as targets, the starter configuration, the
trend line in [re-audits](#re-audits) and the [guide](#the-guide). What is
not built yet is [greenfield](#greenfield) mode and the [calibration](#calibration) entries in
the reflection store. When the item is finished, this design leaves the
folder ([design/README.md](README.md)).

Contents: [the experience](#the-experience) ·
[what the audit relates to](#what-the-audit-relates-to) ·
[proportion](#proportion) · [artifacts](#artifacts) · [profiles](#profiles) ·
[the report source](#the-report-source) · [the sheet](#the-sheet) ·
[decisions and feedback](#decisions-and-feedback) ·
[starter configuration](#starter-configuration) ·
[re-audits](#re-audits) · [greenfield](#greenfield) ·
[calibration](#calibration) · [build order](#build-order) ·
[left out](#left-out)

## The experience

1. **Run.** `/jig:audit` runs as today: configuration fit, the four surveys,
   scoring, the record. On a first audit it asks which
   [profile](#profiles) the team is aiming for. If the team does not know, it
   suggests one from the repository's shape and says why.
2. **Read.** The agent writes a *report source* (structured JSON, like the
   decision sheet's), and the skill renders it to a self-contained HTML
   *audit sheet* and a Markdown copy. The sheet opens with one screen that a
   lead can read in two minutes: the maturity map against the target, the
   three moves that matter most, the quick wins, and what was and was not
   examined.
3. **Decide.** Each recommendation in the sheet offers *accept*, *take the
   lighter option* (where it names one, see [proportion](#proportion)),
   *refine* (accept with a note), *decline* (with a reason and a condition for
   revisiting it), and *this is wrong* (the audit misjudged it). The choices
   are kept in the browser. A tray counts them, and **Copy decisions** puts
   them on the clipboard as one block of text.
4. **Hand over.** The team pastes the block to an agent. The agent runs
   `record.ts apply-feedback`. That validates the block against the record,
   writes each decline into the record's `declined:` list, and prints the
   accepted work ranked as the sheet's Start here ranks it. The agent then opens one pull request per
   accepted recommendation (`/jig:audit apply <ref>`) or files them as
   tracker items.
5. **Re-run.** The next audit compares against the record. The sheet then
   opens with what changed since: fixed, regressed, new, added by Jig. It does
   not repeat a declined recommendation until its condition holds.

## What the audit relates to

- **Modules** (`modules/`): what the audit scores. Each module's maturity
  criteria live in the skill (`criteria/M<n>-*.yaml`). Each criteria file
  gains a one-sentence `purpose`, the plain-language "what this solves" line
  from its module README. That lets the sheet say why a module matters
  without the plugin shipping `modules/`.
- **Principles** (`principles/`): the reasons, not scored. The sheet links
  the principle behind each part of the method. For example, the ladder chips
  link [principle 4](../principles/04-enforcement-ladder.md), and the "derived
  from the repository" notes link
  [principle 1](../principles/01-principles-over-tools.md).
- **Profiles** (`profiles/`): the targets. A profile names, for each module,
  the level a project of that shape should reach. Today that is prose; it
  becomes [machine-readable](#profiles).
- **Adoption paths** (`adoption/`):
  - Brownfield: the sheet orders accepted work by
    [brownfield.md](../adoption/brownfield.md)'s ladder. Fix drift first, then
    the modules in its default order, one rung at a time.
  - Greenfield: the audit becomes the [check](#greenfield) that a new
    repository reached its profile.

## Proportion

An audit that recommends everything is as useless as one that recommends
nothing: a weekend prototype told to adopt numbered decision records and a
staged delivery pipeline stops reading. The practices are worth what they
cost only at the right size, and a project's right size changes as it grows.
So the audit is proportionate by construction, and the team holds the dial.

- **The profile is the dial.** The team declares the profile it aims for;
  the audit recommends toward that target and no further. Without a declared
  profile the audit suggests the *lightest* profile the repository's observed
  facts support, says which facts, and marks it suggested. It never defaults
  to Strict.
- **Trajectory.** The record's optional `heading_to` names the profile the
  project is growing toward (a prototype becoming a product, a product
  entering a regulated market). Recommendations are classified against both:
  - **now**: needed to reach the current target (or a configuration fix);
  - **as you grow**: needed only for `heading_to`'s target;
  - **optional**: beyond both.

  Only *now* items reach the top of the sheet. The other two groups are
  collapsed, say why they are not recommended yet (the profile's name, or a
  conditional target's `when`), and stay choosable for a team that wants them
  early.
- **Conditional targets** (`profile_conditions`) cover practices whose need
  depends on how the team works, not on its size: parallel agent workspaces,
  a codebase large enough that a change's implications stop being obvious.
- **The lighter option.** A recommendation may name a `lighter` way to get
  most of the benefit, usually the convention rung before the mechanical one:
  write the rule down before building a gate
  ([brownfield adoption](../adoption/brownfield.md): codify before you
  mechanize). The sheet offers *take the lighter option* beside accept.
- **Tone.** The sheet says *attained*, *target*, *not yet* and *not needed for
  this profile*; it colours only the gap inside the target. A repository is
  not failing because it is not Strict.
- **Graduation signals.** When observed facts suggest the project has
  outgrown its profile (more contributors, a deploy environment, a
  compliance document), the sheet says so as a suggestion to revisit the
  dial, never as a finding.

## Artifacts

| Artifact | Written by | Canonical for |
|----------|------------|---------------|
| `.config/jig-audit.yaml` (the record) | the audit | scores, evidence, the profile, declined recommendations |
| Report source (`jig-audit-<date>.json`) | the agent, validated by `report.ts` | the summary, recommendations, drift findings, what was examined |
| Audit sheet (`jig-audit-<date>.html`) | `report.ts render` | nothing: a view of the record and the source, with both embedded |
| Markdown copy (`jig-audit-<date>.md`) | `report.ts render` | nothing: the same view as text, for a pull request or a wiki |
| Feedback block | the sheet's copy button | the team's decisions, until `apply-feedback` records them |

The record stays the one source the next run reads. The report source holds
only what the record does not: the prose, the recommendations and the
ranking. The sheet embeds both (and the configuration-fit report and the prior
record when there is one), so `report.ts extract` recovers them from the
file alone, as the other sheets do.

The sheet and its Markdown copy are written outside the repository by
default (`--out`, defaulting to a temporary folder), because they name paths
and settings a team may not want published. A team that wants them committed
names a folder.

## Profiles

`plugin/skills/audit/profiles.yaml` holds the targets that
[profiles/README.md](../profiles/README.md) describes. The README keeps the
reasoning and links the file for the levels:

```yaml
profiles:
  solo-lite:
    name: Solo/Lite
    targets: { M0: lite, M1: lite, M2: lite }
  team-standard:
    name: Team/Standard
    targets: { M0: standard, M1: standard, M2: standard, M4: standard,
               M5: standard, M6: standard, M7: standard, M9: standard }
    conditional:
      M12: { level: lite, when: "several agents work the repository in parallel workspaces" }
      M3:  { level: lite, when: "what a change implies is no longer obvious from its paths" }
  regulated-strict: …
order: [M1, M2, M0, M4, M5, M6, M7, M9, M12, M10, M3, M8, M11]
```

- **The record** gains `profile: <id>`, `profile_conditions:` listing which
  conditional targets the team says apply, and `heading_to: <id>` for the
  profile it is growing toward. All are optional: without a profile the sheet
  shows levels and the suggested profile's gaps, marked suggested.
- **The gap** for a module is the criteria between its attained level and its
  target. A module whose criteria are all `expected-absent` has no gap,
  whatever the profile says. The repository's shape rules it out.
- **Order**: [brownfield.md](../adoption/brownfield.md)'s default order,
  extended to every module, groups the recommendations by module. The work
  to do (Start here, and the work `apply-feedback` prints) is ranked by
  leverage × effort, then a quick win, then the report's order, and drift fixes come
  first.
- **A suggested profile**, when the team has none, comes from observable
  facts: number of contributors, a regulated-domain hint in the repository's
  own documents, deploy environments. The sheet marks it *suggested*, never
  *declared*.

## The report source

One JSON document, validated by `report.ts validate`:

```json
{
  "v": 1,
  "repository": { "name": "example/web", "url": "https://github.com/example/web" },
  "summary": "Two or three sentences a newcomer can read.",
  "profile": { "id": "team-standard", "source": "declared" },
  "examined": {
    "read": ["the instruction files", "CI workflows", "…"],
    "unchecked": [{ "what": "branch protection", "why": "needs admin rights" }]
  },
  "stack": [{ "facet": "CI", "detected": "GitHub Actions", "evidence": ".github/workflows/ci.yml" }],
  "recommendations": [{
    "id": "R1",
    "refs": ["M1/ci-runs-gates-on-pr"],
    "title": "Make the existing CI a merge gate",
    "finding": "What is true now, with evidence.",
    "action": "The concrete next step in the repository's own tools.",
    "evidence": [".github/workflows/ci.yml:31"],
    "leverage": "high", "effort": "small",
    "quick_win": true,
    "lighter": "State in the README that a red run must not be merged; require the check later."
  }],
  "drift": [{ "text": "README says X; CI does Y.", "evidence": ["README.md:12", ".github/workflows/ci.yml:8"] }],
  "terms": [{ "term": "Ratchet", "meaning": "…" }]
}
```

The scores, levels, evidence and configuration findings are not repeated
here. `render` reads them from the record and the configuration-fit report.
Each recommendation's `refs` must name criteria or configuration findings the
record knows. A ref the team has declined (and whose condition does not hold
yet) is refused, so a declined recommendation cannot come back through the
report either.

## The sheet

Built on the decide skill's sheet kit, like the explainer sheet:

- one self-contained HTML file, with no network request;
- readable with JavaScript off and in print;
- text contrast held to the accessibility standard's minimum by a test;
- the time-left bar and the section index.

The sections, in reading order:

1. **Masthead**: repository, date, commit, plugin version, the profile
   (declared or suggested).
2. **In short**: the summary, and beside it the counts. These are the
   criteria met and the recommendations, with how many are quick wins.
3. **Maturity map**: one row per module. Each row has its name, purpose,
   level attained, the profile's target as a marker, and a bar with one cell
   per criterion, coloured by the ladder rung. `n/a` modules are greyed and
   say why. This is the screen a lead screenshots.
4. **Start here**: the top three recommendations and the quick wins, as
   cards.
5. **Since the last audit** (re-audits only): fixed, regressed, new, added by
   Jig, and declined recommendations that are due.
6. **Recommendations**, grouped by module in adoption order. Each card shows
   the finding, the action, the evidence, leverage and effort, the criteria it
   moves, and its choices (see [the experience](#the-experience)). Choosing *decline* opens the reason and
   revisit fields. *Refine* and *wrong* open a note.
7. **Module detail**: per module, every criterion with its level, its score
   chip, how it was decided (a probe or the agent) and its evidence. This is
   the part that shows exactly what was examined.
8. **Configuration fit**: errors, warnings, suggestions, facts. For a
   repository without a configuration file, the [starter
   configuration](#starter-configuration).
9. **Drift**: where what the repository says and what it does disagree.
10. **What was examined**: the stack, what was read, what could not be
    checked and why, and how the scores were reached.
11. **Terms**.

The decision tray is fixed at the bottom of the screen once any choice
exists. It shows the counts per choice, **Copy decisions**, and a reset.
Choices live in `localStorage`, keyed by repository, commit and the report's
fingerprint (a hash of every recommendation's fields), so a sheet regenerated
for a new commit or a changed report starts clean.

### The guide

A first audit is often a team's first contact with Jig, and a report that
assumes the reader knows the method is intimidating. So the sheet carries
its own **guide**: a page inside the same file, always one click away in the
top bar, that a reader returns to as often as they need. With a script it
opens as its own view (`#guide`, with deep links to each part, and back to
where the reader was); without one, and in print, it is the last section.

It explains, in plain words and with the sheet's own icons and module chips:
what Jig and the audit are; the enforcement ladder; the modules with their
one-sentence purposes and what a module's Lite, Standard and Strict levels
mean; the profiles, who each is for, and a table of each profile's
target per module; how the audit works, from the configuration check to the
decisions and the next audit; and how to read the report. It says plainly
that a profile (the whole repository's aim) and a module's level (one
module's rung) share words but are different things, and that the profile
is the team's dial, never a grade.

A first audit opens with a short welcome and a pointer to the guide; a
re-audit keeps only a link. Every term of the method in the report links to
its part of the guide. The guide is built from what the skill ships (the
criteria files' purposes, `profiles.yaml`, its own text), so it cannot drift
from the method it describes.

## Decisions and feedback

The copy button writes one YAML block. YAML because the agent pastes it into
a file the record's own tooling reads, and a person can still read it:

```yaml
# Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)
audit_feedback:
  v: 1
  repository: example/web
  commit: 1a2b3c4
  report: 0123456789ab   # the report's fingerprint, from the sheet
  profile: team-standard
  accept: [R1, R3]
  refine:
    - { id: R2, note: "Use the existing lint job, not a new one." }
  decline:
    - id: R4
      refs: [M5/adrs-exist-numbered-from-template]
      reason: "Two maintainers; decisions live in pull requests."
      revisit_when: "a third maintainer joins"
  wrong:
    - { id: R5, refs: [M2/derived-inventory-exists], note: "dist/ is not committed." }
```

`record.ts apply-feedback <file|->`:

- **Refuses** a block whose repository or report fingerprint differ from the
  report's, whose commit differs from the record's, or whose ids the report
  did not have. A block written for another audit
  must not change this one.
- **Writes** each `decline` into the record's `declined:` list, with
  `refs`, `reason` and `revisit_when`, the same shape a person writes today.
- **Sets** `profile:` when the block changes it.
- **Prints** the work: drift fixes first, then accepted and refined
  recommendations ranked by leverage × effort, then a quick win, then the
  report's order, each with its refs and note, ready for
  `apply <ref>` or for filing. A *wrong* is printed as a calibration finding
  (see [calibration](#calibration)). Its criterion's score in the record is
  left for the agent to re-examine, never flipped silently.

## Starter configuration

`config-fit.ts --draft` prints a starter `.config/jig.yaml` for a repository
without one, and the additions for a repository that has one:

- every value the repository implies: the gate command, review bots, the
  issue-key prefix, a change-area catalog;
- each value with the evidence it came from as a comment;
- nothing that equals the default;
- an addition to a section the file already has, marked to be merged there,
  since a second copy of a section is a duplicate key every skill refuses.

The sheet shows the draft in the configuration section, with a copy button
of its own.

## Re-audits

`record.ts compare` already classifies every criterion. The sheet's *since
the last audit* section shows it. Fixed criteria and regressions come first,
because a regression is the finding a re-audit exists to catch. A `trend`
line follows when older records are given (`--history <record>…`, for
example from `git log -p .config/jig-audit.yaml`): each module's level over
time.

## Greenfield

A new repository runs the audit at the end of the kickoff's repository
bootstrap ([greenfield.md](../adoption/greenfield.md), phase 5) with its
profile declared. Most criteria are absent at that point, and that is
expected. So the sheet leads with the profile check: does each target module
reach its target, and what is left. It drops the full recommendation list for
modules outside the profile. The kickoff family (ROADMAP) calls this step.

## Calibration

A *wrong* decision means the audit misjudged something, which is a defect in
Jig, not in the repository. `apply-feedback` prints each one with its
criterion, the evidence the audit used and the team's note. Once the
reflection store exists (ROADMAP), the same entries are written there as
findings targeting the `audit` skill. That makes repeated misjudgements of
one criterion visible across repositories, and they become a probe fix or a
criterion rewrite.

## Build order

1. Profiles: `profiles.yaml`, `profile:` in the record, target and gap in
   `record.ts summary`.
2. The report source, `report.ts validate | render | extract`, the Markdown
   copy, and the sheet without choices.
3. Choices, the tray, the copy button, `record.ts apply-feedback`.
4. `config-fit.ts --draft` and its place in the sheet.
5. The *since the last audit* section and the trend line.
6. Greenfield mode, called from the kickoff family.
7. Calibration entries into the reflection store, once it exists.

## Left out

- **A hosted dashboard.** The sheet is a file. A team that wants a fleet
  view uses the portfolio comparison.
- **Editing scores in the sheet.** Scores carry evidence. A disagreement is a
  *wrong* decision that the agent re-examines, not a toggle.
- **A portfolio sheet.** The portfolio comparison stays Markdown until a team
  with several repositories asks for the sheet form.
- **A person's values in the starter configuration.** A field whose value
  belongs to one person (their own tracker defaults, local paths) would go to
  `~/.jig/jig.yaml`, never the repository's file. No suggestion produces one
  yet; mark such fields in the schema when one does.
- **A scheduled drift check** (configuration fit and probes, weekly in CI).
  It is plausible, but should wait until a repository has run several audits.

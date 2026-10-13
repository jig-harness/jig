# The audit sheet

The audit sheet is the HTML view of an audit that a team reads and decides
from. It is rendered from two things: the audit record (the scores, the
evidence, the profile and the declined recommendations) and a **report
source**, one JSON file the agent writes after scoring. The report source
holds only what the record does not: the summary, the recommendations, the
drift found, what was examined and the terms used. `report.ts render` writes
the sheet and a Markdown copy with the same content.

The worked example is the execa calibration run: the report source at
`<skill-dir>/__tests__/fixtures/report/execa.report.json`, rendered with the
record `<skill-dir>/calibration/2026-10-12-execa.jig-audit.yaml` and the
configuration-fit report `__tests__/fixtures/report/execa.fit.json`.
`<skill-dir>` is the directory of the `audit` skill (`${CLAUDE_SKILL_DIR}` in
`SKILL.md`).

## Contents

- [The source](#the-source)
- [Recommendations](#recommendations)
- [The profile](#the-profile)
- [Render and check](#render-and-check)
- [What the sheet shows](#what-the-sheet-shows)
- [The decisions block](#the-decisions-block)

## The source

```json
{
  "v": 1,
  "repository": { "name": "example/web", "url": "https://github.com/example/web" },
  "summary": "Two or three sentences a newcomer can read.",
  "profile": {
    "id": "solo-lite", "source": "suggested", "why": "Why this profile fits.",
    "signals": [{ "text": "Seven people committed in the last quarter.", "evidence": ["git shortlog -sn --since=3.months"] }]
  },
  "examined": {
    "read": ["the instruction files", "the CI workflows"],
    "unchecked": [{ "what": "Branch protection", "why": "needs admin rights" }]
  },
  "stack": [{ "facet": "CI", "detected": "GitHub Actions", "evidence": ".github/workflows/ci.yml" }],
  "recommendations": [{
    "id": "R1",
    "refs": ["M1/ci-runs-gates-on-pr"],
    "title": "Make the existing CI a merge gate",
    "finding": "What is true now, with evidence.",
    "action": "The concrete next step, in the repository's own tools.",
    "lighter": "Optional: a lighter way to most of the benefit.",
    "evidence": [".github/workflows/ci.yml:31"],
    "leverage": "high",
    "effort": "small",
    "quick_win": true
  }],
  "drift": [{ "text": "The README says X; CI does Y.", "evidence": ["README.md:12", ".github/workflows/ci.yml:8"] }],
  "terms": [{ "term": "Merge gate", "meaning": "A check that must pass before a pull request can merge." }]
}
```

Required: `v` (1), `repository.name` (one line), `summary`, `examined.read`
(at least one entry), `stack` (at least one row) and `recommendations` (it may
be empty). Optional: `repository.url` (https), `profile`,
`examined.unchecked`, `drift` and `terms`; leave a key out rather than empty.
An unknown key is an error.

- **Do not repeat the record.** Scores, levels, evidence per criterion and
  configuration findings come from the record and the fit report; the sheet
  shows them itself.
- **`stack.evidence`** is one text: name several sources with `; `.
- **`examined.unchecked`** is what could not be read, and why, so the reader
  knows what the scores do not cover.
- **`terms`** define the words of art the summary, findings and actions use.
  The sheet links each one at its first use in a section.
- Write in short sentences, one fact each, in plain words.

## Recommendations

- **`id`** is `R1`, `R2`, …, unique. The team's decisions name it.
- **`refs`** name what the recommendation moves: criteria as `M<n>/<id>`
  (each must be in the record) or configuration findings as `config/<id>`
  (each must be in the fit report, when one is given). The first criterion
  decides the module the card is listed under; a recommendation with only
  configuration refs is listed first, under Configuration.
- **`leverage`** is `high`, `medium` or `low`; **`effort`** is `small`,
  `medium` or `large`. The sheet ranks by leverage × effort.
- **`quick_win`** marks a small change the team can make today.
- **`lighter`** is a lighter way to get most of the benefit, usually the rung
  before the one the action builds: write the rule down before building the
  gate. The sheet offers it as its own choice.
- **`evidence`** lists file paths, or the query that found nothing, at least
  one.
- A recommendation that names any ref the record declines and still holds is
  refused: leave that work out until its date passes (`record.ts compare`
  says which entries are due) or its condition holds, which you record by
  setting the entry's `revisit_after` to today. For an entry naming a
  `config/` finding, save the fit report again with `config-fit.ts --json
  --record <draft record>`: the sheet finds a configuration recommendation's
  refs only among that report's findings, and a report saved against the
  committed record still holds the finding back. A configuration error is
  never held: no decline hides it.

With a profile, declared or suggested, every criterion within the target
that does not meet its bar is a **gap**, and each gap should be either moved
by a recommendation's `refs` or left on purpose. A gap that no recommendation
names and no held decline covers is an **uncovered gap**: the sheet marks it
in the map and the module detail, lists it under the recommendations as *Not
covered by a recommendation* with the criterion's statement, and counts it in
the summary. `report.ts validate --record` prints each one as a warning,
without changing the exit code. Answer each with a recommendation, or leave
it deliberately and say why in the summary.

## The profile

The profile is the team's dial: the sheet measures against it and never
presents a practice beyond it as a shortfall.

- When the record declares a profile (`profile:`), the source may leave
  `profile` out, or repeat it with `"source": "declared"`.
- When it does not, the source may suggest one with `"source": "suggested"`
  and a `why` drawn from facts about the repository: contributors, a
  regulated domain, deploy environments.
- The record's `heading_to:` names the profile the project is growing toward.
- `profile.signals` lists facts suggesting the project has outgrown its
  profile, so the team may want to revisit the dial: more contributors, a
  deploy environment that appeared, a compliance document. Each has a `text`
  and at least one `evidence` entry (a path, or the query that found it). The
  sheet shows them beside the profile as *Worth revisiting the profile*, in a
  neutral tone and never as a finding; the profile stays the team's choice.
  To give signals for a declared profile, repeat it with
  `"source": "declared"`.

Each recommendation is placed by its refs:

| Placement | When |
|-----------|------|
| For now | a criterion it moves is within the profile's target for its module, or it names a configuration finding |
| As you grow | otherwise, a criterion it moves is within the target of the `heading_to` profile |
| Optional | beyond both |

Without any profile, every recommendation is for now. Start here and the
counts draw from "for now" only; the other two groups are folded under the
recommendations, each saying why it is not for now.

## Render and check

Run from the repository under audit:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/config-fit.ts" --json > <scratch>/fit.json
bun "${CLAUDE_SKILL_DIR}/scripts/report.ts" validate <scratch>/jig-audit.json --record <scratch>/jig-audit.next.yaml --fit <scratch>/fit.json
bun "${CLAUDE_SKILL_DIR}/scripts/report.ts" render <scratch>/jig-audit.json --record <scratch>/jig-audit.next.yaml --fit <scratch>/fit.json [--prior .config/jig-audit.yaml [--history <record>]…] [--out <dir>]
```

- `--record` defaults to `.config/jig-audit.yaml`; during an audit, name the
  completed draft. The record must be complete (`record.ts check`).
- `--prior` adds the "since the last audit" section: fixed, regressed, new,
  added by Jig, level changes and the standing of each declined entry.
- `--history <record>`, given once per record and only with `--prior`, adds
  older records of the same repository. The section then shows the **trend**
  in place of the level changes: each module's level at every record's date,
  oldest first, then now, for the modules whose level changed at least once,
  with one line such as "1 module moved up since 2026-04-02". Each record is
  measured against today's criteria without those added after its plugin
  version; a pass bar changed since then is read as it is now, and a criterion
  removed since then is not counted. The records may come
  in any order, and each audit counts once, the prior record too when it is
  also given as history. An audit is its date, commit and scores, so the
  record committed before and after the team's decisions counts once. The
  prior record is the latest before the audited
  one, so a prior dated after the audited record, a history record dated
  after the prior, and two history records of one day are refused. The
  committed record's own history holds them:

  ```bash
  git log --format=%H -- .config/jig-audit.yaml
  git show <commit>:.config/jig-audit.yaml > <scratch>/jig-audit.<commit>.yaml
  ```

- `--out` defaults to a new temporary folder, because the sheet names paths
  and settings a team may not want published. It writes
  `jig-audit-<date>.html` and `jig-audit-<date>.md` and prints their paths.
- `validate` without `--record` checks the source alone; with it, it also
  warns of every uncovered gap and lists them in its output.
- `extract <sheet.html>` prints the source, record, fit report, prior record
  and history records the sheet embeds, so a sheet can be rendered again
  from the file.

Exit codes: 0 done; 1 the source was refused, with every problem listed;
2 usage, or an input that cannot be read.

## What the sheet shows

In reading order: the masthead (repository, date, commit, plugin version,
profile and heading-to profile) with, on a first audit, a welcome that
points to the guide, and on a re-audit a link to how to read the sheet; the
summary with the counts and any signals to revisit the profile; the
maturity map (one row per module in adoption order, one mark per criterion,
its rung's icon on its rung's colour, the target and the heading-to target
as brackets, an amber ring only on a criterion within the target that is
not met yet, and an amber dot on the ring when no recommendation covers
it); Start here; the changes since the last audit, as tables with a
coloured badge per kind of change and the counts as badges above them,
then the trend; the recommendations with the uncovered gaps; every
criterion with its evidence and whether a probe or the agent decided it;
the configuration fit with the starter configuration when the fit report
has one; the drift; what was examined; the terms; and the guide.

The rungs' icons, from [Lucide](https://lucide.dev) (vendored with its
licence in `<skill-dir>/scripts/report/lucide/`), differ in shape as well
as colour:

| Rung | Icon |
|------|------|
| absent | a dashed circle |
| convention | a page of text |
| advisory | an eye |
| mechanical | a shield with a check |
| expected absent | a struck-through circle |
| not scored | a question mark |

Each mark in the map links to its criterion in Module detail and has a
**popover**, shown on hover and on keyboard focus: the criterion's statement,
its level, its bar, its score and what the score means, where it stands
against the profile (within the target and met, a gap, not needed for this
profile, uncovered) and whether a probe or the agent decided it. A module is
named everywhere by the same chip, whose popover gives the module's name and
purpose. The words of the method (profile, level, target, gap, conditional
target, uncovered gap, probe) link to the part of the guide that explains
them.

The **guide** is the sheet's last section: what Jig is, the idea and the
enforcement ladder, every module with its purpose, the profiles with a
table of the target each sets per module, how the audit works, how to read
the sheet, and the words of the method. With JavaScript it is a view of its
own on the `#guide` route (`#guide-profiles` opens a part of it); Back,
Escape or its back link return to the report where the reader was. The
Markdown copy carries a short paragraph on how to read it and a link to the
guide in the sheet.

A criterion was decided by a probe only when its score is `absent` and its
evidence begins `probe: `, the mark `score.ts` writes on the scores its
probes decide. Any other score is the agent's: when the agent scores a
criterion over a probe's result, it writes its own evidence in place of the
probe's.

The page is one self-contained file: no network request, readable with
JavaScript off and in print (the popovers' content is in the legend, Module
detail and the guide, which print shows), and its text colours meet the
accessibility standard's minimum contrast.

## The decisions block

Each recommendation card offers **Accept**, **Take the lighter option**
(where it has one), **Refine**, **Decline** and **This is wrong**. Decline
needs a reason and a condition for revisiting; Refine and This is wrong need a
note. Beside the profile selector, under the maturity map, the sheet lists
the conditional targets of the profile that will apply (the one the reader
chose, else the record's): the targets a profile sets only when the team
says their condition holds. Each shows its module and that condition, checked
as the record's `profile_conditions` has them. In Module detail any criterion's score can be
flagged **This score is wrong**, with a note it needs. The choices stay in
the browser, keyed by repository, commit and the report's fingerprint (a hash
of every recommendation's fields), so a sheet of another version of the
report starts clean. The tray counts them and copies them as one block for
`record.ts apply-feedback`, which refuses a block whose `report:` is not the
fingerprint of the report source it is given:

```yaml
# Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)
audit_feedback:
  v: 1
  repository: "example/web"
  commit: "1a2b3c4d5e6f…"
  report: "0123456789ab"
  profile: team-standard
  profile_conditions: [M3, M12]
  accept: [R1, R3]
  refine:
    - { id: R2, note: "Use the existing lint job, not a new one." }
    - { id: R6, note: "lighter option: Write the rule down first.; We add the gate later." }
  decline:
    - { id: R4, refs: ["M5/adrs-exist-numbered-from-template"], reason: "Two maintainers.", revisit_when: "a third maintainer joins" }
  wrong:
    - { id: R5, refs: ["M2/derived-inventory-exists"], note: "dist/ is not committed." }
  scores:
    - { ref: "M3/consumer-view-generated", note: "The docs build generates the view." }
```

`profile:` appears only when the reader chose a profile other than the
record's. `profile_conditions:` appears when the reader's set differs from
the record's, or when the reader chose another profile and some of its
conditional targets apply; it lists every module whose conditional target
applies, so `[]` says none do. `apply-feedback` refuses a module that is not
a conditional target of the profile that will apply (or of the record's
`heading_to` profile, as the record itself allows), then replaces the
record's list, keeping its comments, or removes it when the list is empty.
`scores:` names criteria the record holds, each with the reader's note;
`apply-feedback` never changes a score, and prints each as a calibration
note with the criterion's statement, its recorded score and evidence and
the note, for the agent to re-examine. Any other empty list is left out. A
taken lighter option is a refine whose note starts with `lighter option: `
and the lighter text, followed by `; ` and the reader's note when there is
one. A block without the newer keys still reads: each is optional, and the
format stays `v: 1`.

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
  "profile": { "id": "solo-lite", "source": "suggested", "why": "Why this profile fits." },
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

## The profile

The profile is the team's dial: the sheet measures against it and never
presents a practice beyond it as a shortfall.

- When the record declares a profile (`profile:`), the source may leave
  `profile` out, or repeat it with `"source": "declared"`.
- When it does not, the source may suggest one with `"source": "suggested"`
  and a `why` drawn from facts about the repository: contributors, a
  regulated domain, deploy environments.
- The record's `heading_to:` names the profile the project is growing toward.

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
bun "${CLAUDE_SKILL_DIR}/scripts/report.ts" render <scratch>/jig-audit.json --record <scratch>/jig-audit.next.yaml --fit <scratch>/fit.json [--prior .config/jig-audit.yaml] [--out <dir>]
```

- `--record` defaults to `.config/jig-audit.yaml`; during an audit, name the
  completed draft. The record must be complete (`record.ts check`).
- `--prior` adds the "since the last audit" section: fixed, regressed, new,
  added by Jig, level changes and the standing of each declined entry.
- `--out` defaults to a new temporary folder, because the sheet names paths
  and settings a team may not want published. It writes
  `jig-audit-<date>.html` and `jig-audit-<date>.md` and prints their paths.
- `validate` without `--record` checks the source alone.
- `extract <sheet.html>` prints the source, record, fit report and prior
  record the sheet embeds, so a sheet can be rendered again from the file.

Exit codes: 0 done; 1 the source was refused, with every problem listed;
2 usage, or an input that cannot be read.

## What the sheet shows

In reading order: the masthead (repository, date, commit, plugin version,
profile and heading-to profile), the summary with the counts, the maturity
map (one row per module in adoption order, one square per criterion coloured
by its rung, the target and the heading-to target as brackets, and an amber
ring only on a criterion within the target that is not met yet), Start here,
the changes since the last audit, the recommendations, every criterion with
its evidence and whether a probe or the agent decided it, the configuration
fit with the starter configuration when the fit report has one, the drift,
what was examined, and the terms.

The page is one self-contained file: no network request, readable with
JavaScript off and in print, and its text colours meet the accessibility
standard's minimum contrast.

## The decisions block

Each recommendation card offers **Accept**, **Take the lighter option**
(where it has one), **Refine**, **Decline** and **This is wrong**. Decline
needs a reason and a condition for revisiting; Refine and This is wrong need a
note. The choices stay in the browser, keyed by repository, commit and the
report's fingerprint (a hash of every recommendation's fields), so a sheet of
another version of the report starts clean. The tray copies them as one block
for `record.ts apply-feedback`, which refuses a block whose `report:` is not
the fingerprint of the report source it is given:

```yaml
# Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)
audit_feedback:
  v: 1
  repository: "example/web"
  commit: "1a2b3c4d5e6f…"
  report: "0123456789ab"
  profile: team-standard
  accept: [R1, R3]
  refine:
    - { id: R2, note: "Use the existing lint job, not a new one." }
    - { id: R6, note: "lighter option: Write the rule down first.; We add the gate later." }
  decline:
    - { id: R4, refs: ["M5/adrs-exist-numbered-from-template"], reason: "Two maintainers.", revisit_when: "a third maintainer joins" }
  wrong:
    - { id: R5, refs: ["M2/derived-inventory-exists"], note: "dist/ is not committed." }
```

`profile:` appears only when the reader chose a profile other than the
record's, and an empty list is left out. A taken lighter option is a refine
whose note starts with `lighter option: ` and the lighter text, followed by
`; ` and the reader's note when there is one.

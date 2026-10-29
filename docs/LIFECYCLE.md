# Jig's delivery lifecycle

Where a piece of work goes next, and who takes it there. Without one page that
says so, a session designing the process finds the skills it already knows and
misses the ones it does not; this page answers "what comes next?" for every
stage, the post-merge pass and the epic close included.
This is Jig's own form of the
[lifecycle map](../modules/M6-feature-delivery-pipeline/README.md#the-lifecycle-map)
of M6, over the plugin's skills.

The stages are named, never numbered. Each names the skill, command or
document that owns it and the artifact it hands on; the detail is in the
owner's own document, not here. The last stage feeds the first.

| Stage | Owner | Hands on | Detail |
|-------|-------|----------|--------|
| steer | [the plan](../design/plan.md), with the proposals of `/jig:audit` and `/jig:review-reflections` | a ranked list of open work | [design/README.md](../design/README.md) |
| spec | [the design skeleton](../design/README.md#starting-a-design), `/jig:explain`, `/jig:decide`, `/jig:adr`, `/jig:red-team` and `/jig:design-brief-builder` | a reviewed design and the decision records it settles | [M6](../modules/M6-feature-delivery-pipeline/README.md), [M5](../modules/M5-adr-practice/README.md) |
| file | `/jig:file-issue` | a labelled tracker issue | [M9](../modules/M9-tasks-memory/README.md) |
| plan the epic | `/jig:file-issue` | an epic of ordered, labelled sub-issues | [M9](../modules/M9-tasks-memory/README.md) |
| pick up | `/jig:do-item`, or `/jig:work-batch` for several small issues from one area | a started issue and a working branch | [do-item](../plugin/skills/do-item/README.md) |
| implement | `/jig:do-item`, through the agent its routing names | a validated change on the branch | [plugin/AGENTS.md](../plugin/AGENTS.md), [modules/AGENTS.md](../modules/AGENTS.md) |
| pre-PR gates | `bun run gates`, `/jig:review`, `/jig:change-areas`, `/jig:github-actions`, `/jig:docs` and `/jig:changelog` | a green gate run, a reviewed diff and a change note | [CONTRIBUTING.md](../CONTRIBUTING.md#quality-gates) |
| draft and drive | `/jig:do-item` opens the pull request, `/jig:drive-pr` drives it | a draft pull request with its review loop armed | [CONTRIBUTING.md](../CONTRIBUTING.md#pull-request-lifecycle) |
| review rounds | `/jig:resolve-review-comments` and `/jig:resolve-conflicts`, run by the drive; `/jig:fix-ci` when a person repairs a red run by hand | every thread resolved with a declared outcome, and green required checks | [drive-pr](../plugin/skills/drive-pr/README.md) |
| merge | a person; an agent never merges ([ADR-0003](adr/ADR-0003-a-person-merges.md)) | the merged commit | [M7](../modules/M7-pr-lifecycle-review/README.md) |
| post-merge | `/followup` | a settled tracker item, filed deferred findings, the release tag and a cleaned-up workspace | [followup](../.claude/skills/followup/SKILL.md) |
| ops drain | `/followup`, which also brings the website and the status pages up to date and files the consumer repositories' work in their trackers; Jig keeps no separate ledger of out-of-tree work | every out-of-tree action the merge owed, done or filed with its owner | [followup](../.claude/skills/followup/SKILL.md) |
| epic close | `/jig:do-item` on the epic, once its sub-issues are settled | an epic closed on an accepted verdict, its tails handed off | [M9](../modules/M9-tasks-memory/README.md#an-epic-closes-on-an-accepted-verdict) |

Skills outside the loop: they serve any stage, or keep the scaffolding true
between loops.

| Skill | Used when |
|-------|-----------|
| `/jig:reflect` | a session learned something about the instructions, skills or gates |
| `/jig:promote-memory` | an agent's private lesson has become knowledge the team should share |
| `/jig:descar` | a document is about to be promoted, or its history has piled up |
| `/jig:docs` | the docs tree needs a health check, or a plan for the documents it lacks |
| `/jig:code-stats` | the repository's size and makeup is needed as evidence |
| `/jig:programmatic-execution` | an analysis reads ten or more files, to run as one script |
| `/website-update` | the site's sources changed since its last check |

## Keeping it true

`bun run gates` resolves every owner named above and every skill Jig ships,
the plugin's and its own in `.claude/skills`, against this page
([M6's lifecycle map gate](../modules/M6-feature-delivery-pipeline/reference/lifecycle-map/README.md)):
a skill that no stage and no row of the second table names, a skill, script
or link that does not exist, and a page this one stops being linked from
[AGENTS.md](../AGENTS.md) all fail it. A new skill is added here in the same
pull request that adds it.

Whether the stages are in the right order is a review question. When the
process changes, a reviewer reads the table top to bottom and asks of each row
whether the artifact it hands on exists and the next stage consumes it.

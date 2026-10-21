# The delivery lifecycle

> TEMPLATE — copy to your repo (e.g. `docs/LIFECYCLE.md`), replace the owners
> with your own skills, commands and documents, and link it from the
> instruction file every session loads (`AGENTS.md`), where it says what to
> read next. The default owners are the Jig plugin's skills. Replace every
> `<...>` placeholder: the gate fails while one remains. Where your repository
> has no skill for a stage yet, link the document that says what happens
> instead, so the cell still names something that exists. Run the
> [lifecycle map gate](https://github.com/jig-harness/jig/blob/main/modules/M6-feature-delivery-pipeline/reference/lifecycle-map/README.md)
> in CI so every owner named below stays something that exists.

Work moves through this loop, and each stage names who runs it and what it
hands on. Ask "what comes next?" of this page, not of memory: a stage that
nobody can find from here gets skipped, and a skill that no stage names is not
found when it is needed.

The stages are named, never numbered: a number is wrong the day a stage is
added. The loop closes: the last stage feeds the first.

| Stage | Owner | Hands on | Detail |
|-------|-------|----------|--------|
| steer | `<the skill or document that ranks open work>` | a ranked list of open work | |
| spec | [the pipeline contract](https://github.com/jig-harness/jig/blob/main/modules/M6-feature-delivery-pipeline/templates/PIPELINE.md), and `/jig:decide` for a dilemma | an accepted PRD, architecture and decision records | [M6](https://github.com/jig-harness/jig/blob/main/modules/M6-feature-delivery-pipeline/README.md), [M5](https://github.com/jig-harness/jig/blob/main/modules/M5-adr-practice/README.md) |
| file | `/jig:file-issue` | a labelled tracker issue | [M9](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/README.md) |
| plan the epic | `/jig:file-issue` | an epic with ordered, labelled sub-issues | [M9](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/README.md) |
| pick up | `/jig:do-item`, or `/jig:work-batch` for several small issues | a started issue and a working branch | |
| implement | `/jig:do-item`, through the agent it routes the issue to | a validated change on the branch | |
| pre-PR gates | `/jig:review`, `/jig:change-areas` | a green gate run and a reviewed diff | [M1](https://github.com/jig-harness/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md), [M3](https://github.com/jig-harness/jig/blob/main/modules/M3-change-area-catalog/README.md) |
| draft and drive | `/jig:do-item` opens the pull request, `/jig:drive-pr` drives it | a draft pull request with its review loop armed | [M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md) |
| review rounds | `/jig:resolve-review-comments`, `/jig:resolve-conflicts` and `/jig:fix-ci`, run by the drive | every thread resolved with a declared outcome and green required checks | [M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md) |
| merge | a person: `<link to the decision record that says so>` | the merged commit | [M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md) |
| post-merge | `/<post-merge-skill>` | a settled tracker, deferred findings filed, scaffolding removed | [M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md) |
| ops drain | `<the skill or document that clears out-of-tree work>` | out-of-tree actions done and recorded | [M10](https://github.com/jig-harness/jig/blob/main/modules/M10-environments-deploy/README.md) |
| epic close | `/jig:do-item` on the epic | an epic closed on an accepted verdict, its tails handed off | [M9](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/README.md) |

Skills outside the loop: the ones that serve any stage, or none in particular.
The gate asks that every skill the repository ships appears on this page, so
none is left where nobody looks.

| Skill | Used when |
|-------|-----------|
| `/jig:explain` | someone must understand how part of the system works today |
| `/jig:audit` | the repository's practices are re-scored against the modules |

## Keeping it true

- Adding a skill or a command adds it here in the same pull request: as the
  owner of a stage, or in the table above.
- A stage with no owner of its own says what happens instead, and links it.
- Whether the stages are in the right order is a review question, not a gate's.
  When the process changes, a reviewer reads the table top to bottom and asks
  of each row: does the artifact it hands on exist, and does the next stage
  consume it?

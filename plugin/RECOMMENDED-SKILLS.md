# Recommended third-party skills

Groundwork ships the procedures it maintains itself. Other people maintain
excellent [skills](../GLOSSARY.md) for neighbouring jobs, and a repository gets
more from installing those from their source than from a copy here: their
authors keep improving them, and a copy would drift. This page lists the ones
that work well alongside Groundwork, what each is good for, and where it fits
in Groundwork's delivery loop.

Each collection installs as its own plugin or skill set, next to Groundwork.
Follow the install instructions in each project's README; they change faster
than this page. Licences are each project's own; read them before you vendor
anything.

## Building and testing skills

From [anthropics/skills](https://github.com/anthropics/skills) by Anthropic
(each skill carries its own licence; these two are Apache-2.0). Installed in
Claude Code as the `example-skills` plugin of the `anthropic-agent-skills`
marketplace.

| Skill | What it is for | Where it fits |
|-------|----------------|---------------|
| `skill-creator` | Drafts a new skill, writes evaluation prompts for it, and iterates on its description so agents invoke it at the right time | Writing your repository's own skills, or a Groundwork skill (see [Add or change a skill](README.md#add-or-change-a-skill)) |
| `webapp-testing` | Drives a local web application in a real browser (Playwright) to check behaviour and capture screenshots and logs | Verifying a user-facing change before `drive-pr` pushes it; a browser check that complements the repository's gates |

## Engineering practice

From [mattpocock/skills](https://github.com/mattpocock/skills) by Matt Pocock
(MIT), a set of small, composable engineering skills.

| Skill | What it is for | Where it fits |
|-------|----------------|---------------|
| `diagnosing-bugs` | A diagnosis loop for hard bugs and performance regressions: reproduce, build a feedback loop, form and test hypotheses, prove the fix | Before `do-item` implements a bug fix, or when `fix-ci` meets a failure whose cause is not in the log |
| `grill-me` | Interviews you about a plan until the open questions are answered | Turning a rough idea into a tracker item that `do-item` can pick up; the requirement stage of M6's [feature-delivery pipeline](../modules/M6-feature-delivery-pipeline/README.md) |
| `to-spec` | Turns a settled conversation into a specification and files it in the issue tracker | The same stage: the item `do-item` later picks up |
| `tdd` | Red–green–refactor with the agent | Implementing an item test-first inside `do-item` |

Earlier versions of this collection also offered `resolving-merge-conflicts`,
which treated each side of a conflict as an intent to trace to its source
rather than as text to pick from (see [Credits](#credits)).

## Verification and debugging discipline

From [obra/superpowers](https://github.com/obra/superpowers) by Jesse Vincent
(MIT).

| Skill | What it is for | Where it fits |
|-------|----------------|---------------|
| `verification-before-completion` | Before an agent claims something is done, fixed or passing, it runs the command that proves it and reads the output | Every round of `drive-pr` and every `do-item` implementation; Groundwork's gates make the claim checkable, this makes the agent check it |
| `systematic-debugging` | A root-cause-first debugging procedure | The same place as `diagnosing-bugs`; pick one |

## Session guardrails and product review

From [garrytan/gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT).

| Skill | What it is for | Where it fits |
|-------|----------------|---------------|
| `freeze`, `unfreeze`, `guard`, `careful` | Restrict which directories a session may edit, and warn before destructive commands | A narrow fix or a sensitive area: keep an agent inside the paths an item is about. Complements M12's [parallel-agent ergonomics](../modules/M12-parallel-agent-ergonomics/README.md) |
| `plan-ceo-review` | Reviews a plan from the product side: is this the right thing to build, and is the scope right | Before an epic is broken into items; the product review of M6's pipeline, alongside Groundwork's `decide` for technical dilemmas |

## Credits

Groundwork's own skills owe these ideas and code to others:

- `decide`'s [Simplified Technical English linter](skills/decide/scripts/ste-lint/README.md)
  is a TypeScript translation of the linter in
  [danyuchn/asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill)
  by Dustin Yuchen Teng (MIT); its licence notice ships beside it.
- [`resolve-conflicts`](skills/resolve-conflicts/SKILL.md) traces each side
  of a conflict to the intent behind it, an approach the `resolving-merge-conflicts`
  skill in [mattpocock/skills](https://github.com/mattpocock/skills)
  popularised.

## Choosing what to add

- Start with the gap you feel: a repository whose agents claim success too
  early gains most from `verification-before-completion`; one whose bugs come
  back gains most from a debugging skill.
- Prefer one skill per job. Two debugging skills give an agent two procedures
  to choose between.
- Record the choice where agents read it: name the installed skills, and when
  to use each, in your repository's `AGENTS.md`
  ([M0](../modules/M0-instruction-architecture/README.md)).

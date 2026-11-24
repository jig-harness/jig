---
release: minor
---

Skills now name a fallback for the forms only one agent program provides that
the gate recognizes (the skill directory variable, the structured question and
the review-arbiter hand-over), and `bun run gates` fails a skill page that does not, so a program without Claude Code's
conveniences can run them.

### Added

- A gate (`scripts/check-skill-runtime-forms.ts`) over the `SKILL.md` and
  reference pages under `plugin/skills` (not READMEs, tests, fixtures or templates).
  It is a heuristic over the phrasings the plugin uses. It fails a page that uses `${CLAUDE_SKILL_DIR}` without saying
  that another program's agent replaces it with the skill's directory, a path
  under it that does not exist once the directory is filled in by hand, a
  mention of `AskUserQuestion` with no plain-text numbered fallback and its
  default beside it, and a hand-over to the `review-arbiter` agent that does
  not say who rules where there are no subagents.

### Changed

- The structured question's fallback is stated the same way in every skill that
  asks one: a plain-text numbered question, the recommended option first and
  marked as the default where there is one (the reply `default` takes it),
  then wait.
- Where the program has no subagents, the calling session makes the
  review-arbiter's rulings itself, with the same rubric and the agent's own
  file as its instructions (`resolve-review-comments`, its triage rubric and
  the agent definition say so).
- `github-actions` and `promote-memory` now explain `${CLAUDE_SKILL_DIR}` as
  every other skill does; `operator` states it in full; `do-item`'s epic-sweep
  reference writes `<skill-dir>`, since a reference page is never substituted.

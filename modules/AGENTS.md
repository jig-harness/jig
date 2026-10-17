# Agent instructions: the practice modules

These add to the [repository's AGENTS.md](../AGENTS.md) for anything under
`modules/`. A module is doctrine first: a reader adopts the practice in their
own stack, so the prose is the product and the code is a portable example.

## The module contract

Every module directory `M<n>-<name>/` carries `README.md` and `mappings.md`,
and holds `templates/` and `reference/` for the assets no skill uses
(see *Where an asset lives* below):

```
README.md      # plain-language opener, invariant, maturity levels, adoption steps, status
templates/     # copyable skeletons (AGENTS.md skeleton, PRD template, …)
reference/     # portable scripts / workflow YAML / schema files, each with a self-test
mappings.md    # per-ecosystem tool mapping table
```

Its machine-evaluable maturity criteria live in the audit skill, as
`plugin/skills/audit/criteria/M<n>-<name>.yaml`, because the plugin installs
only `plugin/` and the audit must read them from any repository. The module
README links its file.

**Where an asset lives.** The plugin installs only `plugin/`, so a skill
cannot read anything under `modules/`. A template or a gate stays in its
module until a skill reads or runs it at run time; then it moves into that
skill, moved and not copied, so the module and the skill never hold two
versions that drift. Nothing moves ahead of a skill that uses it. A skill
that only links a template for its reader to adopt does not use it in this
sense, and the template stays in the module.

- **Templates** a skill uses move to `plugin/skills/<skill>/templates/`.
- **Gates** a skill runs move to the skill's `scripts/`, with their
  self-tests in its `__tests__/` and fixtures beside them. They stop
  importing the repository's `lib/`, which the plugin cache does not have
  ([plugin/AGENTS.md](../plugin/AGENTS.md)). The
  [`changelog` skill](../plugin/skills/changelog/README.md) holds
  [M12](M12-parallel-agent-ergonomics/README.md)'s change-note scripts this
  way.
- **The module keeps** its `README.md`, its `mappings.md` and whatever of
  `templates/` and `reference/` no skill uses. A module whose assets have all
  moved has neither directory. Its README links each moved asset in the skill
  where the adoption steps or **Status** name it (a link, not a restatement),
  and `mappings.md` recipes name the path under `plugin/skills/`. The skill's
  README links back (see "Consistency to keep").

- **README order:** what problem the practice solves and what it looks like
  without it (plain language, before any mechanism), the invariant, the
  maturity levels (Lite / Standard / Strict), adoption steps, then a
  **Status** section: what the module provides, what it deliberately leaves
  out and why, and what is future. No porting history and no source paths
  from another repository.
- **The maturity criteria** follow the format in
  [the criteria README](../plugin/skills/audit/criteria/README.md).
  Criteria are observable repository facts (a file exists, a CI job runs, a
  hook is configured), never quality judgments, scored on the enforcement
  ladder. They are part of the plugin, so a change to them is a plugin change
  ([plugin/AGENTS.md](../plugin/AGENTS.md): version bump and changelog), and
  `bun plugin/skills/audit/scripts/score.ts --check` must still pass.
- **`reference/`** gates are Bun/TypeScript commands with a paired self-test
  and fixtures. A reader adapts them, so they take their inputs as arguments
  and carry no repository's paths. Many share helpers in the repository's
  `lib/` (`lib/module-gates.ts`, `lib/cli.ts`); a reader runs them from a
  pinned Jig checkout or vendors `lib/` with them, and the module's
  `mappings.md` recipes say which.
- **`templates/`** (in a module or in a skill) are copied into other
  repositories: links in them are absolute
  (`https://github.com/docomply/jig/blob/main/…`, a template that lives in a
  skill included: `…/main/plugin/skills/<skill>/templates/…`) because a
  relative link breaks once copied. The Markdown gates skip `templates/`, so
  check those links by hand. Templates are licensed MIT No Attribution, so
  a copy needs no notice: a new template file gets its line in the root
  [NOTICE](../NOTICE) (and `cp NOTICE plugin/`), wherever it lives.
- **A module links to an asset in a skill** by a relative link, like its
  criteria file: the module is documentation in this repository, where the
  link resolves and the Markdown gates check it. A skill's own documents link
  to a module by an absolute URL, since they are read from the plugin cache.
- **`mappings.md`** names real tools per ecosystem; a row is a fact a reader
  can check, so keep it current when a tool renames or retires a feature.

## Consistency to keep

- The module table in [README.md](README.md), the profile targets in
  [profiles/README.md](../profiles/README.md) and the survey-to-module map in
  [audit methodology](../plugin/skills/audit/references/methodology.md) name every module; a new or
  renamed module changes all three.
- When a skill in the [plugin](../plugin/README.md) implements a module's
  practice, the module README links it as the runnable form, and the skill
  links back.

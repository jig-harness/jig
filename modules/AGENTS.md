# Agent instructions: the practice modules

These add to the [repository's AGENTS.md](../AGENTS.md) for anything under
`modules/`. A module is doctrine first: a reader adopts the practice in their
own stack, so the prose is the product and the code is a portable example.

## The module contract

Every module directory `M<n>-<name>/` carries:

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
- **`templates/`** are copied into other repositories: links in them are
  absolute (`https://github.com/docomply/jig/blob/main/…`) because a
  relative link breaks once copied. The Markdown gates skip `templates/`, so
  check those links by hand. Templates are licensed MIT No Attribution, so
  a copy needs no notice: a new template file gets its line in the root
  [NOTICE](../NOTICE).
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

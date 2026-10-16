---
release: minor
---

The plugin gains a home for the code its skills share, and a failing script
can now say why it failed.

### Added

- `plugin/shared/`, beside `skills/`, holds the code more than one skill
  uses. New there: type guards and `decodeJson()`, which names the input and
  the field that did not have the expected shape; `swallow()` and
  `errnoCode()` for errors; an injectable clock; and a logger that writes to
  standard error.
- `JIG_LOG` (`error`, `warn`, `info`, `debug`; default `warn`) and
  `JIG_LOG_FORMAT` (`text` or `json`) set what the scripts' diagnostics say
  ([configuration reference](../plugin/CONFIGURATION.md#environment-variables)).
  Under `JIG_LOG=debug` a failing script also prints the stack of the
  failure and its causes; a failed `gh` call in `resolve-review-comments`
  adds the last 4,096 bytes of its error output, which a timed-out or
  oversized call now prints by default too.
- Each line of drive-pr's driver log starts with its time and a level, and
  the log moves to `drive-pr-<PR>.log.1` before it grows past 10 megabytes.

### Changed

- **Breaking** for repository code that imports one of the plugin's shared
  modules from the installed copy: `cli.ts`, `proc.ts`, `consumer.ts`,
  `config-layers.ts`, `yaml.ts`, `gh-conditional.ts`, `tracker-labels.ts` and
  the vendored YAML parser moved from `skills/resolve-review-comments/scripts/lib/`
  to `shared/`, beside `skills/`. Import them from there. Scripts run by
  path, such as `jig-config.ts`, have not moved.
- **Breaking** for a skills folder copied by hand (a container image's
  `/etc/codex/skills/`, or `~/.claude/skills/` for a tool without plugin
  support): the skills' scripts now import from `shared/`, so copy
  `plugin/shared/` into a `shared/` folder beside the skills folder as well
  ([where it works](../plugin/README.md#where-it-works)). A plugin install
  needs nothing.

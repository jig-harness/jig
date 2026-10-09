# Runnable tools

Repositories need one maintained implementation of their development commands,
so fixes reach every consumer without copying scripts between projects.
Groundwork keeps reusable command-line tools here as they move in.

## Layout

- `plugin/skills/<name>/SKILL.md` — agent procedures and their private
  supporting files, shipped as the `groundwork` plugin ([plugin/README.md](../plugin/README.md)).
- `tools/<area>/` — operated development commands grouped by responsibility.
- `lib/` — shared code used by multiple commands, with no consumer-specific values.
  `lib/test-helpers/` and the temp-dir scope (`lib/test-tmpdir*.ts`) are the shared
  test support; `lib/guarded-git-spawn.ts` is the only sanctioned route to a raw
  spawn in tests that build scratch git repositories.
- `modules/M*/reference/` — the practice gates and worked examples already shipped
  with the modules. They stay beside the doctrine they enforce.
- `scripts/` — Groundwork's own repository checks and build orchestration.

A command binds a named host behind an interface when it needs one. Host names,
tracker policies, gate commands and organization-specific values arrive from
consumer configuration, read at run time from the consumer repository.
[plugin/](plugin/README.md) installs and checks the plugin on a machine and
tests its layout.

## Runtime choice

Use the exact Bun version in [mise.toml](../mise.toml), including when the target
repository uses another language. Run `mise install`, `bun install
--frozen-lockfile` in the Groundwork checkout, then `mise exec -- bun <gate.ts>`
with that checkout's mise configuration active. The runtime belongs to the
Groundwork tooling; it does not change the target repository's application
language or package manager.

This first release uses bundled commands plus a runtime pin. It avoids a separate binary
matrix and keeps gates, fixtures and module references reviewable together.
[Bun supports standalone executables](https://bun.sh/docs/bundler/executables),
but producing and distributing them is a later packaging decision. Moving
files into a consumer requires their relative imports too; prefer operating
from the complete pinned Groundwork checkout.

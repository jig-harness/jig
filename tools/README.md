# Runnable tools

Repositories need one maintained implementation of their development commands,
so fixes reach every consumer without copying scripts between projects.
Jig keeps those reusable command-line tools in one place.

## Layout

- `plugin/skills/<name>/SKILL.md` — agent procedures and their private
  supporting files, shipped as the `jig` plugin ([plugin/README.md](../plugin/README.md)).
- `tools/<area>/` — operated development commands grouped by responsibility.
- `lib/` — shared code used by multiple commands, with no consumer-specific values.
  `lib/test-helpers/` and the temp-dir scope (`lib/test-tmpdir*.ts`) are the shared
  test support; `lib/guarded-git-spawn.ts` is the only sanctioned route to a raw
  spawn in tests that build scratch git repositories.
- `modules/M*/reference/` — the practice gates and worked examples already shipped
  with the modules. They stay beside the doctrine they enforce.
- `scripts/` — Jig's own repository checks and build orchestration.

A command binds a named host behind an interface when it needs one. Host names,
tracker policies, gate commands and organization-specific values arrive from
consumer configuration, read at run time: from the consumer repository, or for
a machine-level command such as the launcher, from the user's home.
[plugin/](plugin/README.md) installs and checks the plugin on a machine and
tests its layout. [launcher/](launcher/README.md) wires an issue tracker's "open in
coding agent" button to a workspace on this machine.

## Runtime choice

Use the exact Bun version in [mise.toml](../mise.toml), including when the target
repository uses another language. Run `mise install`, `bun install
--frozen-lockfile` in the Jig checkout, then `mise exec -- bun <gate.ts>`
with that checkout's mise configuration active. The runtime belongs to the
Jig tooling; it does not change the target repository's application
language or package manager.

Jig ships bundled commands plus a runtime pin. That avoids a separate
binary matrix and keeps gates, fixtures and module references reviewable
together.
[Bun supports standalone executables](https://bun.sh/docs/bundler/executables),
but producing and distributing them is a later packaging decision. Moving
files into a consumer requires their relative imports too; prefer operating
from the complete pinned Jig checkout.

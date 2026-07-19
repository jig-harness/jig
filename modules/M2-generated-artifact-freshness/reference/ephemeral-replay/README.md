# Ephemeral replay — the strongest drift check for schema-like artifacts

A committed database-schema file can drift from the migrations that
supposedly produce it in ways a timestamp or regenerate-and-diff check will
miss: the generator may read a long-lived dev database that has accumulated
manual tweaks, or the migrations may no longer even apply cleanly from
scratch. **Ephemeral replay** closes that gap by testing the whole chain:

1. **Spin** a throwaway environment (here: a Postgres container).
2. **Replay** the source of truth from absolute zero (ordered migrations,
   applied in pinned filename order).
3. **Dump** the resulting schema.
4. **Normalize** both the fresh dump and the committed artifact through the
   *same* pipeline.
5. **Compare**; fail with a "regenerate and commit" message on any diff.

Because every run is a clean-room replay, nothing on the developer's machine
(a mutated local database, another checkout's container) can contaminate the
result, and parallel [worktrees](../../../../GLOSSARY.md) never collide.

`check-schema-drift.sh` is a well-commented, portable skeleton of this
recipe using docker + `psql` + `pg_dump` against a generic migrations
directory (e.g. one whose first migration creates an `orders` table). It is
**one instantiation of a general pattern**: the same five steps apply to any
artifact derived by replaying a source of truth — an IaC plan from
configuration, generated API clients from an interface definition, a search
index from seed data. Swap "container + migrations + dump" for your
equivalents; keep the shape.

```sh
./check-schema-drift.sh <migrations-dir> <committed-schema.sql>
```

## Normalization gotchas (where this pattern actually fails)

Almost every false positive in an ephemeral-replay check is a normalization
bug, not real drift:

- **Normalize both sides identically.** Run the committed artifact and the
  fresh dump through the same normalizer, every time. If you normalize only
  the fresh side, any later fix to the normalizer makes every
  previously-committed artifact look "drifted" until manually regenerated —
  a proven trap in the reference implementation.
- **Strip environment-flavored content at dump time.** Ownership,
  privileges, and tablespaces vary per environment and say nothing about the
  schema: `--no-owner --no-privileges --no-tablespaces --no-security-labels`.
- **Strip version-flavored content in the normalizer.** Comment banners,
  `SET` session statements, and `set_config` calls change across engine
  versions; delete them before comparing.
- **Pin the engine image to an immutable digest** (`<image>@sha256:<digest>`),
  not a floating tag. Dump formatting changes between engine versions, so a
  silently-moved tag manufactures phantom drift. Re-pin deliberately when
  upgrading, and use the same pinned image locally and in CI.
- **Pin ordering.** Apply migrations in `LC_ALL=C` filename order; locale
  collation differences between machines otherwise change the replay order.

## Operational gotchas

- **Readiness is two gates, not one.** The official Postgres entrypoint
  starts a *temporary* server during initialization, stops it, then starts
  the permanent one — and `pg_isready` succeeds during the temporary phase.
  Wait for the entrypoint's init-complete log line first, *then* poll
  `pg_isready`, or the check races and fails intermittently.
- **Name containers per working directory** (hash of the checkout path), so
  parallel worktrees on one machine never fight over one container name.
- **Don't use `--rm`.** If initialization fails, `--rm` deletes the
  container before its logs can be read. Remove explicitly in a cleanup
  trap, with a `KEEP_CONTAINER=1` escape hatch for debugging.
- **Register cleanup before waiting**, so a timeout or Ctrl-C still tears
  the container down.

## Where it sits in the module

Ephemeral replay is the Strict-level drift check for rung 3 of the
drop > check > commit ladder (see the [module README](../../README.md)): the
committed schema artifact keeps its full triad, and this check *is* the CI
drift gate for it. CI-provider and engine variants (GitLab CI, service
containers, MySQL/SQLite) are in [`../../mappings.md`](../../mappings.md).

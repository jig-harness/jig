# M2 mappings — per-ecosystem implementations

The module's [invariant](../../GLOSSARY.md) and its drop > check > commit
ladder (see [README.md](README.md)) are tool-independent. This file maps each
rung's checks onto concrete [CI](../../GLOSSARY.md) providers, [git
hook](../../GLOSSARY.md) managers, and container/database stacks. Replace
`<placeholders>` with your repo's values.

Every command below is a TypeScript script run with [Bun](../../GLOSSARY.md):
`bun <script>.ts`. The runner (CI job, hook or container) needs Bun installed at
a pinned version first — see the toolchain note in
[M1's mappings](../M1-gates-enforcement-ladder/mappings.md).

Run the schema replay script from a pinned Jig checkout: it shares the
plugin's retry, clock and trace helpers as well as `lib/`. A standalone
copy must retain those relative dependencies.

## CI providers, per rung

| Rung | Check | Reference script |
|------|-------|------------------|
| 2 — CI-check, commit nothing | stated-counts drift; referenced-path-exists | [`reference/prose-facts/`](reference/prose-facts/) |
| 3 — commit + triad | regenerate-to-temp-and-diff drift gate | [`reference/triad/check-index-fresh.ts`](reference/triad/check-index-fresh.ts) |
| 3 (Strict, schema-like) | ephemeral replay | [`reference/ephemeral-replay/check-schema-drift.ts`](reference/ephemeral-replay/check-schema-drift.ts) |

### GitHub Actions

```yaml
# Rung 2 — commit-nothing prose checks. Land advisory, promote by deleting
# `continue-on-error` — no script change needed. Add these under any job's
# `steps:` key.
steps:
  - name: Stated-counts drift (advisory)
    run: bun reference/prose-facts/check-stated-counts.ts <instruction-file> <dir> <noun>
    continue-on-error: true
  - name: Referenced paths exist (advisory)
    run: bun reference/prose-facts/check-referenced-paths.ts <instruction-file>
    continue-on-error: true
```

```yaml
# Rung 3 — triad drift gate. Blocking; path-filter to the artifact's inputs.
# .github/workflows/freshness.yml
on:
  pull_request:
    paths: ['<docs-dir>/**/*.md']
jobs:
  freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: bun reference/triad/check-index-fresh.ts <docs-dir>
```

```yaml
# Rung 3 Strict — ephemeral replay. A separate workflow, path-filtered to the
# schema's own inputs, so migration/schema changes trigger it even when no
# docs changed (GitHub Actions filters `on.pull_request.paths` per workflow,
# not per job — hence the separate file rather than a second job above).
# Ubuntu runners ship docker.
# .github/workflows/schema-drift.yml
on:
  pull_request:
    paths: ['<migrations-dir>/**', '<schema.sql>']
jobs:
  schema-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: bun reference/ephemeral-replay/check-schema-drift.ts <migrations-dir> <schema.sql>
```

### GitLab CI

```yaml
# Rung 2 — advisory via allow_failure; promote by deleting that line.
prose-facts:
  script:
    - bun reference/prose-facts/check-stated-counts.ts <instruction-file> <dir> <noun>
    - bun reference/prose-facts/check-referenced-paths.ts <instruction-file>
  allow_failure: true

# Rung 3 — triad drift gate, run only when the inputs changed.
index-freshness:
  script: bun reference/triad/check-index-fresh.ts <docs-dir>
  rules:
    - changes: ['<docs-dir>/**/*.md']

# Rung 3 Strict — ephemeral replay via docker-in-docker...
schema-drift:
  image: docker:27
  services: ['docker:27-dind']
  script: bun reference/ephemeral-replay/check-schema-drift.ts <migrations-dir> <schema.sql>

# ...or skip the container entirely with a GitLab service database: replay
# migrations into the `postgres` service with psql, dump with pg_dump, then
# compare through the reference script's normalizeSchema step.
```

Other providers follow the same shape: any CI that can run a shell script
can run all three rungs. The only provider-specific decisions are the
advisory mechanism (`continue-on-error` / `allow_failure` / equivalent) and
how the runner reaches a database (local docker, docker-in-docker, or a
provider-managed service container).

## Hook managers (rung 3's auto-stage twin)

The pre-commit hook regenerates the artifact and stages it when its inputs
are staged. The hook is a convenience; CI remains the authority.

| Manager | Auto-stage wiring |
|---------|-------------------|
| [lefthook](https://github.com/evilmartians/lefthook) | `glob` on the inputs; `run` the generator then `git add <artifact>`; `stage_fixed: true` |
| [husky](https://typicode.github.io/husky/) | in `.husky/pre-commit`: guard with `git diff --cached --name-only \| grep -q '<inputs-pattern>'`, then generate + `git add <artifact>` |
| [pre-commit framework](https://pre-commit.com) | a local `repo: local` hook with `files: <inputs-pattern>` running the generator; it stages nothing itself, but any file the hook modifies fails the commit, and the standard workflow is `git add` + retry |

Lefthook example (the fullest expression — glob filtering, staging, and
timeout are all declarative):

```yaml
pre-commit:
  commands:
    <artifact>-fresh:
      glob: "<inputs-glob>"
      timeout: 2m
      run: |
        <generate-command>
        git add <artifact-path>
      stage_fixed: true
```

pre-commit framework example:

```yaml
repos:
  - repo: local
    hooks:
      - id: <artifact>-fresh
        name: regenerate <artifact>
        entry: <generate-command>
        language: system
        files: '<inputs-pattern>'
        pass_filenames: false
```

## Container and database variants (ephemeral replay)

| Stack | Notes |
|-------|-------|
| docker + Postgres | The reference script. Pin the image to a digest (`PG_IMAGE`); two-gate readiness (init sentinel, then `pg_isready`); dump with `pg_dump --schema-only --no-owner --no-privileges --no-tablespaces --no-security-labels` |
| podman + Postgres | The script runs a `docker` executable, so install podman's docker-compatible command (e.g. the `podman-docker` package); a shell alias is not enough. Rootless mode avoids CI privilege requirements |
| CI service container | GitHub Actions `services:` / GitLab `services:` start the database for you — replay with a psql client and keep only the script's normalize-and-compare step |
| testcontainers | Same recipe inside a test framework, when the repo already uses one; readiness and teardown come for free |
| MySQL/MariaDB | Dump with `mysqldump --no-data`; normalize away `AUTO_INCREMENT=` values, `/*!` version comments, and the dump-date footer |
| SQLite | No container at all: replay migrations into a temp file with `sqlite3`, dump with `.schema`, diff. The cheapest full-chain replay there is |

Whatever the engine, the invariants hold: replay from zero, pin versions and
ordering, normalize both sides identically, and always tear down, even on
failure or interrupt.

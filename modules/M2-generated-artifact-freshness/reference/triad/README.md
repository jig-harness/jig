# The freshness triad — worked example

When a [generated artifact](../../../../GLOSSARY.md) (a file produced by a
script from some source of truth) genuinely has to live *in* the repo, three
things must ship together or the artifact will silently rot:

1. **A generator** — one script that derives the artifact deterministically.
2. **A drift check** — a CI job that regenerates to a temp file, diffs against
   the committed copy, and fails with a "run this to fix" message.
3. **An auto-stage hook** — a pre-commit hook that regenerates and `git add`s
   the artifact whenever its inputs are staged, so local commits go out fresh.

This is rung 3 of the module's decision ladder (**drop > check > commit** —
see the [module README](../../README.md)). Reach for it only when consumers
genuinely need the artifact at rest; prefer rungs 1–2 (never commit, or
commit-nothing checks — see [`../prose-facts/`](../prose-facts/)) when they
don't, because a committed artifact also merge-conflicts when parallel
branches both regenerate it.

The worked example here derives an `index.md` from a directory of markdown
files. The same shape applies to any derived artifact: API specs from route
definitions, ORM types from migrations, dependency notices from lockfiles.

## Files

| File | Role |
|------|------|
| `generate-index.sh` | Generator: docs tree in, deterministic `index.md` out |
| `check-index-fresh.sh` | Drift check: regenerate to temp, diff, fail loudly |
| `fixture/docs/` | Tiny docs tree (with its committed, fresh `index.md`) to run against |

Try it (POSIX shell, no dependencies):

```sh
sh generate-index.sh fixture/docs        # regenerate the artifact
sh check-index-fresh.sh fixture/docs     # exit 0: fresh
echo '# New page' > fixture/docs/new.md
sh check-index-fresh.sh fixture/docs     # exit 1: stale, prints the fix
```

## Wiring the third leg: the auto-stage hook

The hook makes freshness the path of least resistance: an author who edits a
source file never has to remember the generator. With
[lefthook](https://github.com/evilmartians/lefthook) (see
[`../../mappings.md`](../../mappings.md) for husky and pre-commit variants):

```yaml
pre-commit:
  commands:
    index-fresh:
      glob: "<docs-dir>/**/*.md"
      run: |
        sh reference/triad/generate-index.sh <docs-dir>
        git add <docs-dir>/index.md
      stage_fixed: true
```

Two hard-won details worth keeping:

- **Skip the self-trigger.** If the only staged doc change *is* the artifact
  itself (a regeneration commit), exit early — otherwise the hook loops on
  its own output. Guard with
  `git diff --cached --name-only | grep -v 'index\.md$'` before regenerating.
- **The hook is a convenience, not the authority.** Hooks can be bypassed
  (`--no-verify`); the CI drift check is what actually blocks a stale
  artifact. Without the hook, authors hit the red CI check and a
  regenerate-push loop ("green locally, red on CI"); without the CI check,
  the hook's coverage is voluntary. You need both.

## Wiring the drift check into CI

Minimal GitHub Actions job (GitLab CI and other variants in
[`../../mappings.md`](../../mappings.md)); path-filter it to the artifact's
inputs so it only runs when they can have changed:

```yaml
on:
  pull_request:
    paths: ['<docs-dir>/**/*.md']
jobs:
  index-freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: sh reference/triad/check-index-fresh.sh <docs-dir>
```

## Determinism rules for generators

The drift check is only as good as the generator's determinism. Same inputs
must give byte-identical output:

- No timestamps, hostnames, usernames, or invocation arguments in the output
  (the header here is deliberately static).
- Pin sort order (`LC_ALL=C sort`) — locale-dependent collation makes two
  machines "drift" while agreeing on content.
- Write to a temp file and `mv` into place, so a crash never leaves a
  half-written artifact.
- Mark the artifact as generated in its first line, with the regenerate
  command, so a hand-editor is warned before they type.

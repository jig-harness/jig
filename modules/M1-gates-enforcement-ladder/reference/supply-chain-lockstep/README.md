# Supply-chain policy lockstep

Part of [M1 Gates & enforcement ladder](../../README.md), core piece 7.

A [release cooldown](../../../../GLOSSARY.md), its exemptions and the
[install-script allowlist](../../../../GLOSSARY.md) are each enforced in
several places: by the dependency updater when it proposes a bump, and by
every package manager at install time, each in its own file and its own unit
(the updater counts days, one installer minutes, another seconds). Edited by
hand, the copies drift: one installer is weakened to no cooldown while the
others still hold, a package allowed to run scripts under one installer is
blocked under another, the updater exempts a package the installers do not.
Nothing notices, because each file is valid on its own.

`check-supply-chain-lockstep.ts` reads the policy from one file and checks
that every installer and updater file it is given states exactly that policy.
It only detects; it changes nothing.

## Usage

```bash
bun check-supply-chain-lockstep.ts --policy supply-chain-policy.yaml \
  [--bunfig bunfig.toml] [--package-json package.json] \
  [--npmrc .npmrc] [--pnpm-workspace pnpm-workspace.yaml] \
  [--renovate renovate.json5] [--dependabot .github/dependabot.yml] \
  [--root <dir>]
```

- `--policy` — the policy file (below); required.
- One option per installer or updater file the repository has; at least one.
  A file not named is not checked, and the scope line says so.
- `--root` — the directory findings name files relative to; default the
  current directory.

The script imports helpers from the Jig repository's `lib/` (`cli.ts`,
`findings.ts`, `record.ts` and the vendored YAML parser), so run it from a
pinned Jig checkout or vendor `lib/` with it. It needs no installed
dependency, so it can run before the install step of a CI job (below).

## The policy

One YAML file states the three values; every installer and the updater must
state the same. [`templates/supply-chain-policy.yaml`](../../templates/supply-chain-policy.yaml)
is the copyable form.

```yaml
cooldown:
  days: 3                 # a whole number of days, at least 1
  exempt:                 # exact package names the cooldown does not apply to
    - typescript
install-scripts:
  allow:                  # packages that may run lifecycle scripts at install
    - esbuild
```

Each list holds exact package names, each once. A pattern (`@scope/*`, a
regular expression, a negation) is refused, because it would trust whatever
is published under it later. A list may be absent, which means empty.

## What each file must state

An absent list counts as an empty one, except Bun's `trustedDependencies`:
omitted, Bun runs the install scripts of its own built-in list of trusted
packages, so the field is required even when the allow list is empty. The
installers write the cooldown in their own units; the gate converts.

| Option | File | Must state |
|---|---|---|
| `--bunfig` | `bunfig.toml` (Bun) | `[install] minimumReleaseAge` = the cooldown in seconds; `minimumReleaseAgeExcludes` = the exempt list |
| `--package-json` | `package.json` (Bun) | `trustedDependencies` = the allow list, set even when empty and never `null` (Bun rejects it) |
| `--pnpm-workspace` | `pnpm-workspace.yaml` (pnpm) | `onlyBuiltDependencies` = the allow list, and no other setting that grants builds (`dangerouslyAllowAllBuilds`, `neverBuiltDependencies`, `onlyBuiltDependenciesFile`, an `allowBuilds` entry that is not `false`); `minimumReleaseAge` = the cooldown in minutes; `minimumReleaseAgeExclude` = the exempt list |
| `--npmrc` | `.npmrc` (pnpm) | Only beside `--pnpm-workspace`, for a pnpm version that still reads its settings from `.npmrc` (current pnpm reads only authentication and registry settings there): `minimum-release-age` = the cooldown in minutes; the `minimum-release-age-exclude` list = the exempt list; no setting that grants builds, since the allowlist lives in the workspace file (`dangerously-allow-all-builds` is accepted only as the boolean `false`). Read as npm's ini parser reads it: a key without `=` is `true`, a quoted key or value is decoded as npm decodes it (single quotes stripped, then read as JSON, keeping its type, so `'[false]'` is a list), `true`, `false` and `null` are those values, a key ending in `[]` makes a list that every later or earlier assignment to the key joins, and a camel-case key is the same setting as its kebab-case spelling, so setting both is a finding. The workspace file is checked in full either way |
| `--renovate` | `renovate.json5` | `minimumReleaseAge` = the cooldown; `internalChecksFilter: "strict"`, set explicitly; at most one package rule with `minimumReleaseAge: "0 days"`, naming exactly the exempt list in `matchPackageNames` and selecting by nothing else, and one when the list is not empty; no rule shortening the cooldown to anything else; when the allow list is not empty, exactly one package rule with `automerge: false` naming exactly the allow list and selecting by nothing else, and it is the last rule, because a later rule overrides an earlier one |
| `--dependabot` | `.github/dependabot.yml` | at least one `updates` entry for `npm` or `bun`, and in each: `cooldown.default-days` = the cooldown, no `semver-*-days` below it, no `include`, `exclude` = the exempt list |

The updater's security path (Renovate's `vulnerabilityAlerts`, Dependabot's
security updates) is not read: a fix for a known vulnerability may skip the
cooldown.

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Every file given states the policy | `supply-chain-lockstep: OK — <n> file(s) state the policy …`, with the three values and the files read, and what the gate does not check |
| 1 | At least one file does not | One finding per disagreement, each with the file, the rule, the problem and the fix; under GitHub Actions also as an `::error` annotation on the file |
| 2 | Could not check, and no file disagrees | `supply-chain-lockstep: could not check: <reason>`, one line per file that could not be checked |

The gate fails closed: a policy that is missing, empty or not a policy (a
pattern where a name is required, a cooldown under one day), a file that
cannot be read or parsed (not TOML, not JSON, not JSON5, not YAML, no
`updates` list), a run that names no installer or updater file, `--npmrc`
without `--pnpm-workspace`, an `.npmrc` with a `[section]`, with a key
that names an environment variable (`${NAME}`, which npm and pnpm expand at
install time into a key the gate cannot know), or with a dotted key whose
value is an object or null (`a.b='{}'`, which npm nests into the setting `a`,
replacing it), or a bad option exits 2. A file that parses but does not state the policy is a finding, not a
could-not-check: the installer would run without the policy. Each file is
checked on its own, so a file that cannot be read does not stop the others,
and a finding in any of them makes the exit 1.

## Running it before any script can run

The gate judges which packages may run install scripts, so it must run
before any install that could run them. Either run it before the install
step (it needs no installed dependency), or install with scripts off:
`bun install --ignore-scripts`, `pnpm install --ignore-scripts`,
`npm ci --ignore-scripts`. A job that installs normally and then runs the
gate has already run whatever the change allowed.

Jig runs it on itself as `bun scripts/check-supply-chain-lockstep.ts`, one
of the repository checks in `bun run gates`, and in CI before the install
step of its gates job. It reads the `bunfig.toml` and `package.json` of
both install roots, the repository's and the website's.

## What it leaves to the team

The gate reads the files it is given; whether the updater is installed and
running on the repository is not something a file can show, and the files of
an installer the gate does not read yet (npm's and yarn's cooldown settings)
are checked by hand. Which packages belong on the allow list is the team's
decision: the gate holds the files to it, it does not judge it.

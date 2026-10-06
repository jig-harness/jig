# Installing shared skills and helpers

Consumers need the same maintained procedures on every machine, without copying
large skill directories into each repository. This installer keeps one verified
release per host and gives each [worktree](../../GLOSSARY.md) its own generated
agent instructions. Without it, copies drift, remote checks lose ignored files,
and a change to one consumer can accidentally change another.

## Invariant

An install is reproducible from an immutable release, selected skills and a
consumer [overlay](../../GLOSSARY.md). A cached release is published only after
verification. Offline check mode verifies the complete release and regenerates
the instructions from the current inputs. Both agent harnesses receive the same
procedure, with separately declared frontmatter.

## Consumer contract

Commit a pin as `.groundwork.json` (or pass `--pin <path>`):

```json
{
  "version": "v1.0.0",
  "repository": "git@github.com:example/groundwork.git",
  "revision": "<full 40-character Git commit>",
  "manifest": "<64-character SHA-256 digest of groundwork-release.json>"
}
```

The revision must identify a Git tree containing `release/`, produced below.
The manifest is a [release manifest](../../GLOSSARY.md): a list of every payload
path, content digest and executable bit. Its digest in the consumer pin anchors
verification of the manifest itself. Git fetch uses the host's existing Git
credentials; no additional token is introduced.

The JSON consumer overlay uses the existing `skills` and
`harness.claude_frontmatter` contract. It also accepts independent
`harness.codex_frontmatter`. Other fields are consumer-owned values:

```json
{
  "skills": ["example"],
  "gates": { "command": "bun run gates" },
  "harness": {
    "claude_frontmatter": {
      "example": { "allowed-tools": "Read Bash(bun *)", "model": "sonnet" }
    },
    "codex_frontmatter": {}
  }
}
```

Canonical `SKILL.md` files have YAML frontmatter and body placeholders such as
`{{gates.command}}`. Missing values fail installation. Strings, numbers and
booleans render literally; lists of strings render comma-separated. Added
frontmatter keys cannot override canonical keys, and values are quoted strings
without control characters. Frontmatter is never substituted as body text.
The caller supplies an already resolved JSON overlay; standards-manifest and
overlay distribution stay with the consumer's asset distributor.

From a provisioned Groundwork checkout, install with one command:

```sh
bun /path/to/groundwork/tools/install/install.ts --consumer . --overlay consumer-overlay.json
```

The same command with `--check` verifies offline. `--cache <directory>` overrides
the default `${XDG_CACHE_HOME:-~/.cache}/groundwork`. Cache directories are named
`<version>-<manifest digest>`, so distinct payloads cannot collide even if a
release label is reused. Installed versions never fetch. Check mode never
fetches or repairs files. Exit 0 means success; an invalid or drifted install
exits nonzero with the affected path.

The installer creates:

- `.groundwork/adapters/{claude,codex}/<name>/SKILL.md` — generated instructions.
- Supporting files materialized as verified, owned copies inside the adapters,
  retaining their original paths.
- `.claude/skills/<name>` and `.agents/skills/<name>` — links to the local adapters.
- `.groundwork/overlay.json` — the resolved runtime configuration, recorded and
  verified alongside the generated instructions. Installed scripts read it from
  the invoking consumer worktree rather than from the host cache.
- `.groundwork/install.lock.json` — input fingerprint, manifest identity and
  every installed file's digest/mode or exact link target. Check mode treats it
  as a record of link-versus-copy choices only: required files, link targets and
  copy digests are recomputed from the verified release and rendered adapters.
- `.groundwork/lib/` — importable shared test helpers materialized as verified,
  owned copies in the consumer. These are installed even when the overlay
  selects no skills.

Only these installed paths are appended to `.gitignore`; other project skills
stay visible to Git. The installer keeps its lines in a marked block that it
rewrites on every install, so deselecting a skill removes exactly its lines and
rules the project wrote itself stay.
On hosts without symlink permission, links become copies.
`--copies` explicitly chooses this mode. Copies receive the same content checks.
Windows lacks a POSIX executable bit, so mode checks run on macOS/Linux; Windows
checks bytes, regular-file types and link destinations.

Installation refuses to overwrite a skill not owned by its prior lock. Move an
existing in-repository skill aside explicitly when adopting it. Reinstall
removes previously installed skills that are no longer selected and leaves
unrelated project skills alone. To stop the install while retaining the pin,
install once with `"skills": []`; then remove the pin and the install hook.
That install still publishes `.groundwork/lib/`, so first drop any imports of
it and the `bunfig.toml` preload, then delete `.groundwork/lib/` (the
installer owns it) so a fresh checkout has no dangling references.
After a pilot deletes its old source, rollback means pinning the last good
release or vendoring that release into the consumer.

## Importing shared helpers

Consumer code imports the installed files using paths relative to its own
location. For a test at the repository root:

```ts
import { spawnSync } from "./.groundwork/lib/guarded-git-spawn.ts";
import { expectSpawnExit } from "./.groundwork/lib/test-helpers/expect-spawn-exit.ts";
```

The guarded spawn requires an explicit environment without the repository-routing
variables exported in `LEAKY_GIT_ENV`. Filter those names case-insensitively
after merging environment overrides. It returns Node's subprocess result;
pass `{ ...result, exitCode: result.status }` to `expectSpawnExit`.

To contain test scratch directories, add
`preload = ["./.groundwork/lib/test-tmpdir-bun-preload.ts"]` under `[test]` in
the consumer's `bunfig.toml`. A consumer needing its own directory prefix or
environment names instead imports `scopeTestTmpdir` from
`.groundwork/lib/test-tmpdir.ts` in a small preload, passes its own options,
and registers `afterAll(() => scope.release())`. Child processes must receive
the current environment explicitly to inherit the scope.

Offline check requires regular helper files, verifies their bytes against the
release manifest and rejects missing or extra files. Reinstall can replace
unchanged links recorded by an older installer with current copies. It refuses
a helper tree that differs
from its install records; move an edited tree aside before reinstalling. To adopt
a release, switch imports and delete the old consumer implementations in the
same rollout.

## Release packaging

The release also ships importable support modules: guarded Git spawning,
subprocess exit assertions, the temporary-directory scope and its Bun preload.
They retain their source paths and relative imports and need no `node_modules`.

Using the runtime in [mise.toml](../../mise.toml), run from this checkout:

```sh
bun install --frozen-lockfile
bun tools/install/release.ts . dist/release v1.0.0
```

The packager refuses an existing output directory. It prints the manifest
digest, copies skill instructions/references and excludes tests/fixtures.
Skills can retain TypeScript source and ship their supporting modules. The
review skill uses this path so consumer compilers
can check its public imports and discovery directories without stripped types.
Its YAML configuration parser ships as a small wrapper with checked TypeScript
declarations around a bundled dependency; installed copies need no package
download. Other skills bundle each script entry
point with its dependencies inlined.
Entry points use `import.meta.main`, `isEntryPoint(...)` or `runMain(...)`;
Supporting modules ship with retained-source skills; other skills inline them
into bundled entry points. The review skill exports its ladder, process and conditional-request
modules for sibling skills. Process cancellation uses one shared handler across
imported modules and bundles. A consumer runner with its
own process API registers each owned group through `registerCancellationGroup`
and calls the returned release function when that group settles. Each registration
owns an independent token; releasing it twice cannot remove another owner.
Bundled scripts retain their `.ts`
paths because procedures already invoke those paths with Bun. Runtime data must
live alongside the skill; imports of external runtime files need an explicit
packaging seam before a skill moves. The payload includes `mise.toml` and a
bundled `tools/install.js`; application consumers need no `node_modules`.

Verified payload files and shared helpers are copied into the worktree's owned
`.groundwork` directories. Discovery directories link to those local adapters
where the host supports links. Imported TypeScript therefore stays inside the
consumer repository, where compilers and code analyzers can resolve it safely;
the immutable release remains in the shared host cache. Both the cache and the
materialized files are checked against the release manifest.

Publishing is a separate human decision. A release publisher places this payload
at `release/` in the Git tree it publishes and records that tree's full commit
and the printed digest. The publisher must preserve modes and bytes. The
installer disables Git line-ending conversion while checking out the payload.
This change neither publishes a release nor decides cadence or visibility.

The test suite executes a bundled `isEntryPoint` / `runMain` procedure through
both discovery paths, checks its output and exit status, and verifies that
importing it does not run its main function. It runs in the repository's native
macOS/Linux/Windows continuous integration (CI) matrix.

## Developing against a working tree

```sh
bun tools/install/install.ts --consumer /path/to/consumer --overlay consumer-overlay.json --local /path/to/groundwork
```

`--local` (or `GROUNDWORK_LOCAL_RELEASE`) accepts a working tree or a prepared
release directory. Working trees are bundled into local cache snapshots without
Git fetch. Changes to `skills/`, `lib/`, `tools/`, `package.json`, `mise.toml` or Bun lockfiles
invalidate the snapshot; reinstall after edits. Install dependencies with the
frozen lockfile first. Changes made directly inside `node_modules` are outside
the source contract. A prepared release must already have a valid manifest.
Checks fail if the current source no longer matches the installed snapshot.
Normal pin-based installs do not select a local snapshot.

When changing the packager itself, invoke the working tree's
`tools/install/install.ts`. An older bundled installer uses its own packaging
code even when `--local` selects newer skill source.

## Headless hosts and CI

The remote-gates host must run installation **after** receiving the consumer
tree and **before** running gates; ignored files are absent from transferred
trees. Provision the pinned installer and runtime using the host's existing
checkout credentials, then use the same install command above and its own host
cache. Forge slots follow the same contract. Provisioning-name exclusions are
part of the later single-source skill rollout, not inferred here.

CI restores the host cache under a key containing the complete pin, installs
unconditionally (which fetches only on a cache miss), then runs `--check` before
consumer gates. See [templates/ci-install.yml](templates/ci-install.yml) for a
GitHub Actions example. An installed cache works offline; a cache miss requires
the existing Git host. The bundled installer can be supplied by host provisioning
or the standards asset distributor, so it is available even on cache misses.
The distribution test starts with no ignored worktree files and runs that
bundled installer against a real Git release.

## Locks and interrupted runs

Host fetches and local builds use atomic directory locks and publish a complete
verified payload with rename. Worktree writes use a separate lock, staging the
adapters before replacing discovery paths. A lock times out after two minutes
and reports its owner's process id; after confirming that owner is dead, remove
the lock directory and retry. Interrupted staging directories can be removed
when no installer is active. Before any discovery path is
published the lock is marked pending, holding the planned records and the ones
they replace; check refuses a pending lock. The next install replaces or deletes
a discovery path only where disk matches one of those record sets exactly (links
and, for copies, the whole directory), judged per surface. An interrupted run is
repaired, and a project skill created afterwards is never deleted. `.gitignore`
is replaced by writing beside it and renaming, before anything is published, so
a failure there keeps the original and publishes nothing. Run checks
after installation completes, since checks do not lock or repair the worktree.

## Validation and rollout

`bun test tools/install/install.test.ts` exercises two actual Git worktrees in
separate concurrent processes, offline reinstall, complete-cache tampering,
adapter/link/copy drift, selection cleanup, local overrides, failed-fetch
cleanup and a headless host receiving no ignored files. `bun run gates` includes
these tests and bundles the installer.

The installer was also exercised on the real Linux build host with Bun 1.4.0:
cold fetch, both discovery paths, a fresh gates-style consumer missing all
ignored files, forced-copy mode, script execution and cached offline reinstall
passed in a disposable directory. That validates host installation, not the
consumer's production remote-gates workflow.

Live laptop-to-remote-gates adoption needs the pilot skill and consumer pin
rollout. Those changes also retire the consumer's old skill synchronizers and
delete the moved skill copies in the same rollout. This installer does not
replace those programs before consumers switch. Actual majordomo and
remote-gates verification remains a pilot acceptance step.

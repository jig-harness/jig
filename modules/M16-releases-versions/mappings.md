# M16 mappings — per-ecosystem implementations

The module [invariant](README.md) is tool-independent: a changelog per
released artifact, written for its consumers; the version chosen once,
after the merge, by one release run at a time; a tag only on the commit that
released it, once its checks pass; and a release identity let past the
branch's rules only as far as the release needs. This page maps it onto
release tools, CI providers, hosting services and package registries. Replace `<placeholders>`
with your values.

## Release tools — per ecosystem

Each tool below writes the changelog after the merge, and most set the
version too. towncrier and scriv only collect the fragments under a version
they are given: choosing that version and writing it into the artifact's
version file stay a separate step of the release. The tools differ in what a
pull request records, who writes the entry, and how the release reaches the
integration branch.

| Tool | Ecosystem | What a pull request records | Release step | Changelog and version |
|------|-----------|-----------------------------|--------------|-----------------------|
| [`changelog` skill](../../plugin/skills/changelog/README.md) | any (Bun scripts, a GitHub Action) | a change note, `changes/*.md`, with `release: patch\|minor\|major` | `release.ts` after each merge, one run at a time; its workflow template pushes the commit as a GitHub App or opens a release pull request, and its tag job tags each releasing commit once its required checks pass | Keep a Changelog or Common Changelog; the version in JSON, TOML or YAML files, a `VERSION` file, or only tags; one artifact per repository |
| [Changesets](https://github.com/changesets/changesets) | JavaScript / TypeScript packages | `.changeset/*.md`, naming each package and its bump | `changeset version`; its GitHub Action keeps a "Version Packages" pull request open for a person to merge, then `changeset publish` publishes and tags | a `CHANGELOG.md` per package; versions in each `package.json` |
| [towncrier](https://towncrier.readthedocs.io/) | Python, any | `newsfragments/<id>.<type>` | `towncrier build --version <v>`; the version is given, not computed, and the version file is not written | configurable template and types |
| [scriv](https://scriv.readthedocs.io/) | Python, any | `changelog.d/*.md` or `.rst` | `scriv collect --version <v>`; the version is given, and the version file is not written | Keep a Changelog's types by default |
| [changie](https://changie.dev/) | any (Go binary) | `.changes/unreleased/*.yaml`, one kind each | `changie batch <version\|auto>`, then `changie merge`; `auto` derives the bump from the kinds | configurable; Keep a Changelog's kinds by default |
| [release-please](https://github.com/googleapis/release-please) | any, from Conventional Commits | nothing: the commit subject is the entry | keeps a release pull request open, updated after each merge; merging it tags and creates a GitHub Release | `CHANGELOG.md` and the version file per release type |
| [semantic-release](https://github.com/semantic-release/semantic-release) | any, from commit messages | nothing: the commit subject is the entry | runs on each push to the release branch and tags and publishes in the same run; with `@semantic-release/git` it first commits the changelog and the version | the changelog through its `@semantic-release/changelog` plugin; the version in the registry and the tag |

Choose by what the pull request should record: the change-note tools (the
skill, Changesets, towncrier, scriv, changie) have the author write the
entry for the artifact's consumers when the change is fresh; the commit
tools write it from the commit subject.

## Generating from commits

Release-please and semantic-release need nothing per pull request, so
nothing conflicts, but each changelog entry is a commit subject, written for
a reviewer of the diff rather than a consumer of the artifact, and a change
only the maintainers notice still produces an entry unless its commit type
(`ci:`, `chore:`, `docs:`) is configured out. With them, the rule for what
gets an entry becomes the rule for which commit types are listed, and the
reviewer checks a pull request's type the way they would check a note.
GitLab's changelog API does the same from `Changelog:` trailers in commit
messages. semantic-release tags and publishes in the run that finds the
release; with `@semantic-release/git` it commits the changelog and the
version first and tags that commit, before any check on it has run. Where
tags must follow verification, prefer a tool that leaves the tag to a later
job.

## Several artifacts in one repository

A repository that releases several artifacts at their own versions keeps a
changelog and a version per artifact, and each change names the artifacts it
reaches.

| Tool | How it keeps them apart | Tags |
|------|-------------------------|------|
| [Changesets](https://github.com/changesets/changesets) | each changeset names its packages and the bump for each; a `fixed` group keeps packages at one version, and a `linked` group aligns versions only among packages that release together | `<package>@<version>` |
| [release-please](https://github.com/googleapis/release-please) (manifest) | `release-please-config.json` lists each package's path and release type; `.release-please-manifest.json` holds each one's version | `<component>-v<version>` by default |
| [Nx Release](https://nx.dev/features/manage-releases) | version plans (`nx release plan`) name each project and its bump, or Conventional Commits; independent or fixed versioning per group | `<project>@<version>` for independent projects, `v<version>` for a fixed group, configurable |
| [release-plz](https://release-plz.dev/) | per crate of a Cargo workspace, from Conventional Commits, through a release pull request | `<crate>-v<version>` |
| Go modules | a module in a subdirectory is versioned by tags of its own | `<subdir>/v<version>`, as the Go toolchain requires |
| [`changelog` skill](../../plugin/skills/changelog/README.md) | one artifact per repository today ([README](README.md#future)) | `<tag_prefix><version>` |

Artifacts that always release together at one version, such as a plugin
whose two manifests carry the same version, are one artifact: one
changelog, one version, the files listed together.

## What gets an entry

The rule is the repository's own, written where contributors read it; these
are the usual answers for one released artifact:

| The change | Entry |
|------------|-------|
| A new capability, a changed behaviour or default, a deprecation, a removal | yes |
| A fix to something a consumer could hit; a security fix | yes |
| Documentation that ships with the artifact or that its consumers read to use it | yes, when it changes what they do |
| A refactor, a test, a CI or build optimization with no effect on what ships | no |
| The repository's own scripts, agent instructions and contributor documents | no |
| A website about the project, deployed rather than released | no; its own deploy history is [M10](../M10-environments-deploy/README.md)'s |
| A dependency update | only when a consumer sees it (a changed peer range, a security fix, a dropped runtime) |

A tool that requires a record from every pull request has a way to say "no
entry": Changesets' `changeset --empty`, or a skip label the repository's
own CI step honours (towncrier, scriv and changie ship none); the
`changelog` skill requires a note only where `changelog.release_paths` or
`changelog.note_paths` cover a changed file.

## Tagging after verification

| Provider | The tag job |
|----------|-------------|
| GitHub Actions | the [`changelog` skill](../../plugin/skills/changelog/README.md)'s workflow template: a `tag-plan` job, started when a check run completes on the integration branch and on a schedule, lists each version whose releasing commit's required checks have passed (`tag.ts --json`); a `tag-push` job that holds the App's key and runs nothing from the repository creates the annotated tags through GitHub's API. A cancelled check is run again once with `actions: write` granted to that job alone. Elsewhere: a job started by `workflow_run` of the gate workflow that reads the commit's check runs before it tags |
| GitLab CI | a `tag` job in the last stage of the integration branch's pipeline, which runs only when every earlier stage passed on that commit, creating the tag through the Releases or Tags API with a project access token held in a protected variable |
| any | the job that publishes starts on a tag (`on: push: tags: ['v*']`, `rules: - if: $CI_COMMIT_TAG`), never on a push to the integration branch |

Protect the tag names too, so the release identity is the only one that
creates them: a GitHub tag ruleset on `refs/tags/<tag_prefix>*` with the
release App as its one bypass actor, or GitLab's protected tags.

## Checking what the package holds

A check on the source cannot see the package built from it: a file left out
of what gets published, an entry point that points at nothing once the build
has run, types that resolve under one module setting and not another, a test
folder shipped inside the library. These checks read what the build packs.
Make them required checks, so they run on the pull request for early
feedback and again on the releasing commit: the release step changes
versions and the changelog in a commit of its own, and the tag lands on that
commit only once its required checks have passed.

| Ecosystem | Check | What it reads |
|-----------|-------|---------------|
| npm | [publint](https://publint.dev/) | the package's `package.json` against the files it would publish, after the build: entry points naming missing files, export conditions in an order a bundler misreads, fields some environments ignore |
| npm, with TypeScript types | [Are the Types Wrong?](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (`attw --pack .`) | the tarball `npm pack` makes: whether each entry point's types resolve under `node10`, `node16` and `bundler` module resolution, and whether the module format the types claim is the one the code ships |
| npm | `npm pack --dry-run` | the list of files the tarball would hold, for a check that compares it with the list the repository expects |
| Python | [`twine check`](https://twine.readthedocs.io/en/stable/) | the built distributions' metadata: whether the long description renders on PyPI |
| Python | [check-wheel-contents](https://github.com/jwodder/check-wheel-contents) | a built wheel: compiled `.pyc` files, duplicate files, a top-level `tests` or `docs` package, and, given the source tree (`--package` or `--src-dir`), modules of it missing from the wheel |
| Rust | `cargo package --list`, `cargo publish --dry-run` | the files the crate's archive would hold; the dry run also builds the packaged crate on its own, which catches a file the build needs and the package leaves out |

## The release identity

| Host | Pushes the release commit | Or, a release pull request |
|------|---------------------------|----------------------------|
| GitHub | a GitHub App with Contents read and write (never Workflows), installed on the repository alone, its client ID and private key in a deployment environment only the integration branch may use; a ruleset lets it bypass the pull-request and check rules, and a second ruleset with no bypass actor keeps force pushes and deletion blocked for it. The `changelog` skill's App manifests and `release-access.ts` set up and check this. A push with the workflow's `GITHUB_TOKEN` starts no other workflow, so the release commit would get no checks and its tag would start no publishing | the App with Pull requests read and write as well, force-pushing a release branch no rule protects and opening the pull request; no identity bypasses the integration branch's rules |
| GitLab | a project access token or a deploy key allowed to push to the protected branch, held in a protected, masked CI/CD variable | a merge request opened by the same token from a release branch |

Either way, the job that holds the key runs nothing from the repository:
the release step runs in an earlier job without it and hands its commit on.

## Publishing without a stored token

The job that publishes from the tag needs the registry's permission. A
long-lived registry token kept as a CI secret can be read by any workflow
that reaches the secret, and it stays valid after it leaks. With
[trusted publishing](../../GLOSSARY.md), the registry is told once which
repository, workflow file and, optionally, deployment environment may
publish the package. The publishing job proves it is that workflow with a
short-lived identity token its CI provider issues, and the registry answers
with a publish credential that expires within minutes. It is the release
identity above applied to the registry: allowed to publish this package from
this workflow, and nothing else. Name a deployment environment in the
registry's configuration and let only the release tags use it, so a workflow
on another branch cannot publish.

| Registry | CI providers | The publishing job, on GitHub Actions |
|----------|--------------|--------------------|
| [npm](https://docs.npmjs.com/trusted-publishers) | GitHub Actions, GitLab CI/CD and CircleCI, on their hosted runners | `permissions: id-token: write` and `npm publish` with npm 11.5.1 or later (Node 22.14.0 or later). A public package published from a public repository on GitHub or GitLab gets [provenance](../../GLOSSARY.md) without a flag. A trusted publisher configured after 3 September 2026 allows only `npm stage publish`, which waits for a maintainer to approve each version, until its settings also allow `npm publish`; allow it, or publish staged. Once it works, the package's publishing access can disallow tokens altogether |
| [PyPI](https://docs.pypi.org/trusted-publishers/) | GitHub Actions, GitLab CI/CD, Google Cloud, ActiveState | `permissions: id-token: write` and [`pypa/gh-action-pypi-publish`](https://github.com/pypa/gh-action-pypi-publish), which also uploads a publish attestation for each file by default: it names the workflow that uploaded the file, not the one that built it; the credential lasts 15 minutes |
| [crates.io](https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07) | GitHub Actions | `permissions: id-token: write`, [`rust-lang/crates-io-auth-action`](https://github.com/rust-lang/crates-io-auth-action) in a step with an `id`, then `cargo publish` with that step's `token` output as `CARGO_REGISTRY_TOKEN`. The crate's first version is published by hand; the trusted publisher is then set in the crate's settings |

The other CI providers request the identity token their own way (GitLab
CI/CD's `id_tokens` with the registry as its audience, for one); the
registry's page linked in the first column gives the steps for each.

## Release channels

A channel is a name a consumer installs from that the release tooling moves
from one released version to another.

| Ecosystem | A channel is | Promotion and rollback |
|-----------|--------------|------------------------|
| npm | a dist-tag (`latest`, `next`, or one of the project's own) | `npm dist-tag add <package>@<version> <tag>` points the tag at another published version, earlier or later |
| A plugin installed from a Git repository | a branch of generated commits, each holding the plugin as installed, built from a version's tag | a new commit on the branch, carrying a later version's tree or an earlier one's; Jig's plugin does this ([plugin/README.md](../../plugin/README.md#release-channels)) |

## Packages to try before the merge

A consumer can try a change before it merges only if they can install it. A
[preview package](../../GLOSSARY.md) is built from a pull request's commit
and installed from an address that names the pull request or the commit. It
is not a release: it has no changelog entry, no version the release step
chose and no tag, and it moves none of the release channels (a preview in
the registry gets a dist-tag of its own that no release uses), so the
version is still chosen once, after the merge. The job that builds it runs
the pull request's own code, so it holds none of the release's credentials.

| Ecosystem | A preview package |
|-----------|-------------------|
| npm | [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new): its GitHub App installed on the repository, and `pkg-pr-new publish` run once in the pull request's workflow. It serves the package from an address of its own (`npm i https://pkg.pr.new/<owner>/<repo>/<package>@<commit>`, or `@<pull-request>`) and publishes nothing to npm |
| npm, in the registry | a prerelease version under a dist-tag of its own that no release uses, never `latest`. npm lets a package have several trusted publishers, but each one can publish any version of that package under any dist-tag, so a preview publisher on the release's own package could publish a stable version that consumers' version ranges select. Previews therefore go under a package of their own (`<package>-preview`, say), which no consumer depends on unless they ask for it, with its own trusted publisher, apart from the release's, which only an environment the release tags may use can reach: a preview workflow file and a deployment environment only the default branch may use. That workflow starts on `workflow_run` when the pull request's workflow completes, which runs it on the default branch whatever the pull request's branch. A consumer installs a preview under the package's own name with an alias (`npm i <package>@npm:<package>-preview@<version>`). The pull request's job writes the preview package's name and the version (Changesets' [snapshot releases](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md): `changeset version --snapshot <tag>`), builds, and packs it into a tarball with `npm pack`, which it keeps as an artifact. Publishing to npm needs the registry's permission, which no job that runs the pull request's code may hold, and publishing a package directory (`npm publish`, `changeset publish`) runs that package's own scripts (`prepublishOnly`, `prepare`, `postpublish`). So a separate job receives the tarball and publishes it as it is, running none of them: `npm publish <tarball> --tag <tag> --registry <registry> --access <access> --ignore-scripts`, from the preview workflow, under the preview package's trusted publisher, which allows `npm publish`. That job trusts nothing the pull request produced, its data included: npm reads the `package.json` inside the tarball for more than the name and version. A stable version there would satisfy consumers' version ranges whatever dist-tag it carries, a top-level `tag` there replaces the one passed with `--tag` (so it can move `latest`), and its `publishConfig` can send the package to another registry (`registry`, or a scope's own `@<scope>:registry`) or make a private package public (`access`). So before publishing, the job reads that `package.json` and refuses unless the name is the preview package's, the version is a prerelease that names the pull request's commit (Changesets' `prereleaseTemplate` can put `{commit}` in it), and it has no top-level `tag` and no `publishConfig` at all. Every setting that decides where and how the package is published (the dist-tag, the registry, which is an `https://` address, and the access) comes from the job's own configuration and is passed as a flag, never from the pull request. npm allows unpublishing only within limits, so these versions stay in the registry; prefer an address outside it |
| Python | PyPI's [test index](https://test.pypi.org/), separate from PyPI itself: install the package's dependencies from PyPI first, then the preview alone (`pip install --index-url https://test.pypi.org/simple/ --no-deps <package>`), since the test index does not hold them; or the wheel kept as an artifact of the pull request's CI run |
| Rust | a git dependency on the pull request's commit (`<crate> = { git = "<url>", rev = "<commit>" }`) |
| Go | `go get <module>@<commit>`, which resolves the commit to a pseudo-version |

# M16 mappings — per-ecosystem implementations

The module [invariant](README.md) is tool-independent: a changelog per
released artifact, written for its consumers; the version chosen once,
after the merge, by one release run at a time; a tag only on the commit that
released it, once its checks pass; and a release identity let past the
branch's rules only as far as the release needs. This page maps it onto
release tools, CI providers and hosting services. Replace `<placeholders>`
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

## The release identity

| Host | Pushes the release commit | Or, a release pull request |
|------|---------------------------|----------------------------|
| GitHub | a GitHub App with Contents read and write (never Workflows), installed on the repository alone, its client ID and private key in a deployment environment only the integration branch may use; a ruleset lets it bypass the pull-request and check rules, and a second ruleset with no bypass actor keeps force pushes and deletion blocked for it. The `changelog` skill's App manifests and `release-access.ts` set up and check this. A push with the workflow's `GITHUB_TOKEN` starts no other workflow, so the release commit would get no checks and its tag would start no publishing | the App with Pull requests read and write as well, force-pushing a release branch no rule protects and opening the pull request; no identity bypasses the integration branch's rules |
| GitLab | a project access token or a deploy key allowed to push to the protected branch, held in a protected, masked CI/CD variable | a merge request opened by the same token from a release branch |

Either way, the job that holds the key runs nothing from the repository:
the release step runs in an earlier job without it and hands its commit on.

## Release channels

A channel is a name a consumer installs from that the release tooling moves
from one released version to another.

| Ecosystem | A channel is | Promotion and rollback |
|-----------|--------------|------------------------|
| npm | a dist-tag (`latest`, `next`, or one of the project's own) | `npm dist-tag add <package>@<version> <tag>` points the tag at another published version, earlier or later |
| A plugin installed from a Git repository | a branch of generated commits, each holding the plugin as installed, built from a version's tag | a new commit on the branch, carrying a later version's tree or an earlier one's; Jig's plugin does this ([plugin/README.md](../../plugin/README.md#release-channels)) |

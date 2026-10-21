# M16 — Releases & versions

**What problem this solves.** Software that others download, embed or
consume (a library, a command-line tool, a plugin, a service's client
library) reaches them as versions, and the people who use it decide from
the version number and the changelog whether an upgrade is safe and what it
brings. Without a release practice, those two signals stop meaning anything.
The changelog lists everything that merged: a restyled project website, a
faster CI job and a renamed internal script sit beside the one change that
breaks a user's configuration, which nobody then finds. A repository that
ships two things (a library and its command-line tool, the packages of a
monorepo) puts both in one changelog under one version, so a fix to one
looks like a release of the other. Whoever merges picks the next version,
so two pull requests claim the same one, or a breaking change goes out as a
patch. And a release is tagged by hand on whatever commit was current,
before its checks finished, so the job that publishes from the tag ships
code nobody verified. This module is the practice that keeps both signals
honest: one changelog per thing you release, written for the people who use
that thing; the version chosen once, after the merge, from what the changes
do to those people; and a tag only on the commit that released it, once its
own checks pass.

[M10](../M10-environments-deploy/README.md) covers software that is
deployed: a service that runs where its users reach it. This module covers
software that is released in versions for others to install. A repository
that does both (a service and its published client library) follows both.

## Invariant

> Each **released artifact** (a thing the repository publishes at a version
> for others to install, embed or consume) has **one changelog, written for
> that artifact's consumers**: an entry says what changed for someone who
> uses the artifact, and a change that reaches none of its consumers (CI, the
> repository's own tooling, its website, documents only its maintainers
> read) has no entry. A repository that releases several artifacts at their
> own versions keeps a changelog and a version per artifact, and each change
> names the artifacts it reaches. **The version is chosen once, after the
> merge**, by a release step that runs one at a time on the integration
> branch and takes the largest bump the waiting changes ask for, judged by
> what each does to a consumer, never by a pull request, and **a change to
> what an artifact ships cannot merge without saying which release it
> needs**. **Each version is tagged on the commit that released it, and on
> no other, once that commit's own required checks pass**, so whatever
> publishes from a tag ships only verified code. **The identity that writes
> the release is let past the integration branch's rules only as far as the
> release needs**, or the release arrives as a pull request a person merges.

Everything below is that one tool-independent statement made mechanical;
the per-ecosystem wiring lives in [mappings.md](mappings.md).

## Core pieces

1. **Name what you release, and who reads about it.** List each released
   artifact, where its version lives (a `package.json`, a `pyproject.toml`,
   a plugin manifest, only its git tags) and where its changelog is. Each
   changelog has one audience: the consumers of its artifact. Write down
   which changes get an entry: a new capability, a changed behaviour or
   default, a fix to something a consumer hit, a deprecation, a removal, a
   security fix. Changes that only the repository's own maintainers notice
   get none: a CI optimization, a refactor, a test, the repository's own
   scripts and agent instructions, internal design documents, and a project
   website, which is deployed rather than released and is
   [M10](../M10-environments-deploy/README.md)'s. A changelog that lists
   them buries the entries its readers need.

2. **A changelog per artifact.** A repository that releases one artifact
   keeps one changelog. One that releases several at their own versions (a
   monorepo's packages, a library beside its command-line tool) keeps a
   changelog and a version per artifact, usually beside the artifact's own
   manifest, and each change record names the artifacts it reaches, with
   the bump each needs. Artifacts that always release together at one
   version (a plugin and its two manifests, a package published under two
   names) are one artifact here. Tags then name the artifact as well as the
   version (`<artifact>@1.4.0`, `<artifact>/v1.4.0`), so each artifact's
   history is its own.

3. **The version follows what the change does to a consumer.** Versions
   follow [semantic versioning](../../GLOSSARY.md)
   ([semver.org](https://semver.org)): a change that breaks something a
   consumer relies on (a removed or renamed feature, a changed
   default, a stricter check) asks for a major bump (a minor one before
   1.0.0), a compatible new capability a minor one, a fix a patch one. The
   size of the diff never decides it. A breaking entry says what a consumer
   must change.

4. **The version is chosen once, after the merge.** Each pull request
   records the release it needs in a change record of its own (a
   [change note](../../GLOSSARY.md), as
   [M12](../M12-parallel-agent-ergonomics/README.md#core-pieces) calls it),
   never by editing the version. After the merge, a release step on the
   [integration branch](../../GLOSSARY.md) writes the waiting records into
   the changelog and sets the version to the largest bump any of them asks for, as one
   version: one commit, one tag, so every tag names exactly the tree it
   points at. Release runs never overlap; a run that finds several merges
   waiting releases them together. A branch check fails a pull request that
   changes the files an artifact ships without a record that asks for a
   release, since its consumers receive the change only through a new
   version, and fails one that sets the version or adds to the changelog's
   sections itself.

5. **A tag only on verified code.** Each version is tagged on its
   [releasing commit](../../GLOSSARY.md), the first commit on the
   integration branch's own (first-parent) history whose changelog has that
   version, and only once every check the branch requires has passed on that
   commit itself; a later commit's success never stands in for it. A
   publishing job (a package registry upload, a GitHub Release) starts from
   the new tag, so it ships only a commit that passed its checks. A release
   commit whose checks failed stays untagged and is reported, for a person.
   This tag is a different ref from M10's
   [verified pointer](../M10-environments-deploy/README.md#core-pieces),
   which advances after verification to record what runs; M10 does not
   require a tag per version, and this module does.

6. **The release identity, let past the rules only as far as it needs.**
   The release step's commit reaches a protected integration branch in one
   of two ways. Either a dedicated machine identity (a
   [GitHub App](../../GLOSSARY.md), a deploy key) pushes it, allowed past
   the branch's pull-request and check rules and nothing else: it can change
   contents only, never workflows; its key is held by an environment only
   the integration branch may use; force pushes and deletion stay blocked
   for it too; and the job that holds the key runs nothing from the
   repository. That is [M10's exception for a machine
   identity](../M10-environments-deploy/README.md#release-state-off-the-source-line),
   applied to the integration branch. Or no identity passes the rules: the
   release step regenerates a [release pull request](../../GLOSSARY.md)
   after each merge, and a person merges it.

7. **The integration branch is not a release pointer.** M10's rule that a
   release pointer only ever fast-forwards to verified source governs a
   pointer that says what production runs. A release step commits to the
   integration branch before that commit's own checks pass, which a pointer
   that may advance only to verified source cannot allow, so the two must
   be different refs. A repository whose integration branch is also that
   pointer moves the pointer to a ref of its own before it adopts a release
   step that commits.

## Maturity levels

- **Lite** — the repository names each artifact it releases, with its
  changelog and where its version lives; a written rule says which changes
  get a changelog entry (those the artifact's consumers would notice) and how
  a change's version bump is judged; and each release is tagged.
- **Standard** — a release step on the integration branch, one run at a time,
  sets each artifact's version from what the waiting change records ask for,
  and no pull request sets it; a check fails a pull request that changes what
  an artifact ships without a record asking for a release; and a repository
  that releases several artifacts at their own versions keeps a changelog
  and a version per artifact.
- **Strict** — each version is tagged automatically on its releasing commit
  once that commit's required checks pass, and publishing starts from the
  tag; and the identity that writes the release is narrowed to what the
  release needs (contents only, its key held for the integration branch
  alone, force pushes and deletion still blocked for it), or the release
  arrives as a pull request a person merges.

This module is **expected-absent for a repository that releases no
versioned artifact**: a deployed service with no client library, a web
application deployed rather than installed, a website, a documentation
repository. It is not expected-absent for a deployed service that also
publishes one; the audit calibrates by what the repository publishes, not by
its shape alone.

## Adoption steps

1. Write down what the repository releases: each artifact, its changelog,
   where its version lives, and its consumers. Put it where contributors
   read before their first change (the contributing guide, or the
   changelog's own opening paragraph).
2. Write the rule for what gets an entry: what the artifact's consumers
   would notice gets one, what only the maintainers notice does not, with
   the repository's own examples of both. Agents follow it when they write a
   change's record.
3. Move each changelog to change records written after the merge
   ([M12](../M12-parallel-agent-ergonomics/README.md) core piece 6), with the
   tool for your ecosystem from [mappings.md](mappings.md), or the plugin's
   [`changelog` skill](../../plugin/skills/changelog/README.md), whose
   `/jig:changelog setup` walks a person through it. For several artifacts
   at their own versions, pick a tool that keeps one changelog per artifact
   ([mappings.md](mappings.md#several-artifacts-in-one-repository)).
4. Name the files each artifact ships as the paths whose change requires a
   record that asks for a release (the skill's `changelog.release_paths`),
   and run the branch check on every pull request.
5. Tag after verification: add the job that tags each releasing commit once
   its required checks pass, and start publishing from the tag rather than
   from a push to the integration branch.
6. Give the release its identity, or switch it to a release pull request,
   and check that the branch's rules let it through and nothing more (the
   skill's `release-access.ts` reads this from GitHub).

## Status

### Runnable form

Jig's [plugin](../../plugin/README.md) carries the
[`changelog` skill](../../plugin/skills/changelog/README.md), which implements
this module for a repository with one released artifact: agents write each
change's note and judge its release, a branch check holds pull requests to
the repository's `changelog:` configuration, a release step writes the notes
into a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) or
[Common Changelog](../../GLOSSARY.md) file and sets the version, and a
GitHub Action with a workflow template runs the check, the release (pushed,
or as a release pull request) and the tag after verification.

### What the module provides

| Piece | What it is |
|-------|------------|
| [`changelog` skill](../../plugin/skills/changelog/README.md) | The runnable form: the change note's procedure, `check.ts`, `release.ts`, `status.ts`, `tag.ts`, `convert.ts`, `release-access.ts`, the GitHub Action and the workflow template, and `/jig:changelog setup` |
| [`mappings.md`](mappings.md) | Release tools per ecosystem, tools for several artifacts in one repository, tagging after verification, checks of what a package holds, the release identity per CI provider, publishing without a stored token, listing what a release contains, release channels and packages to try before the merge |
| [maturity criteria](../../plugin/skills/audit/criteria/M16-releases-versions.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

### Left out by design

- **Publishing.** Uploading to a package registry, creating a GitHub
  Release, announcing a version: each is a repository's own pipeline,
  started by the tag this module makes. The module asks only that a
  release's publishing start from the tag. A
  [preview package](mappings.md#packages-to-try-before-the-merge) built
  from a pull request is not a release: a separate job publishes it, from
  the pull request's commit, and it moves none of the release channels.
  [mappings.md](mappings.md#publishing-without-a-stored-token) shows how
  a registry lets the release's job publish without a stored token, and
  [what to check](mappings.md#checking-what-the-package-holds) in the
  package before it does.
- **Pre-release and calendar versions.** The practice holds for them, but
  the skill writes plain `major.minor.patch` versions; a repository that
  needs others uses a tool from [mappings.md](mappings.md) that writes them.
- **Writing entries from commit messages.** A commit subject is written for
  a reviewer of the diff, an entry for a consumer of the artifact. Tools
  that generate the changelog from commits are compared in
  [mappings.md](mappings.md#generating-from-commits).
- **Deploying.** A service's path from merge to production is
  [M10](../M10-environments-deploy/README.md)'s.

### Future

- **Several artifacts in the `changelog` skill.** The skill keeps one
  changelog and one version per repository; a repository that releases
  several artifacts uses a tool from
  [mappings.md](mappings.md#several-artifacts-in-one-repository) until it
  keeps one per artifact ([roadmap](../../ROADMAP.md)).
- **A whole-changelog format check.** The branch check reads each note and
  the release step writes well-formed sections, but no check yet validates
  a whole changelog against its format's rules (structure, section names and
  order, dates, link references) ([roadmap](../../ROADMAP.md)).
- **Release channels.** An artifact released several times a day can offer
  [release channels](../../GLOSSARY.md): one that takes every tagged version,
  and one a version reaches by [promotion](../../GLOSSARY.md) after a
  [soak](../../GLOSSARY.md) with its checks green and no open regression,
  with a rollback that withdraws a bad one. Jig's plugin runs it for a
  plugin installed from a Git repository
  ([plugin/README.md](../../plugin/README.md#release-channels)); how other
  ecosystems carry it is in [mappings.md](mappings.md#release-channels). It
  becomes a core piece, with an audit criterion, once a second repository
  has run it.
- **A bill of materials for each release.** A released artifact can carry
  a [software bill of materials](../../GLOSSARY.md) generated from the
  tag's commit, which a consumer's scanner reads and some regulations
  require; [mappings.md](mappings.md#listing-what-the-release-contains)
  names the generators per ecosystem and how to attest one. It becomes a
  core piece, with an audit criterion, once a repository has run it in its
  release.
- **Other CI providers.** The skill's check and release step run on any
  provider; its workflow template, its tag job and its access check are
  GitHub's until a repository needs another.

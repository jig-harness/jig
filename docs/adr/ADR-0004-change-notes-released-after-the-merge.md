---
title: "ADR-0004: A pull request adds a change note; the release is written after the merge"
type: adr
status: amended
description: "Pull requests never add to CHANGELOG.md's open sections or move the plugin version; a release step on main writes their change notes and moves the version, and the release commit is tagged once its gates pass"
lifecycle: permanent
version: "1.4"
last_updated: 2026-10-18
owner: maintainers
decision_date: 2026-10-15
supersedes: ~
superseded_by: ~
tags: [adr, release, changelog, parallel-work]
---

# ADR-0004: A pull request adds a change note; the release is written after the merge

**Status:** Approved · **Date:** 2026-10-15 · **Deciders:** Jig's maintainers

## Context

Jig is worked by many agents in parallel, each on its own pull request
([M12](../../modules/M12-parallel-agent-ergonomics/README.md)). Until now,
each pull request added its entry at the top of
[CHANGELOG.md](../../CHANGELOG.md)'s Unreleased section, and each one that
changed `plugin/` also bumped the version in both plugin manifests and added
that version's section ([ADR-0002](ADR-0002-the-plugin-is-its-directory.md)).
Every merge then put every other open pull request in conflict: the same
lines of the changelog, the same version field, and often the same version
number claimed by two branches. Each conflict cost an agent a resolution and
the pull request another full CI run, and a renumbered branch had to rewrite
its version section and any `since:` that named the version.

## Decision

A pull request records its change as a **change note**, a file of its own
under [`changes/`](../../changes/README.md) holding its Keep a Changelog
sections and, when it changes `plugin/`, the release it needs
(`release: patch|minor|major`). It never edits the changelog's Unreleased or
release sections, nor the plugin version; a file that must name the version
(a criterion's or a configuration field's `since`) names `next`.

After every merge, `.github/workflows/release.yml` runs `scripts/release.ts`
on main's newest commit, one run at a time. It writes notes without a release
under Unreleased; when a note asks for a release, it writes those notes as the
next version's section, moves both manifests to it, replaces `since: next`,
deletes the notes, commits, tags `v<version>` and pushes. It does this one
merge at a time, in the order the merges landed, so each merge that changes
`plugin/` is still its own release, as ADR-0002 requires, even when several
merged before the run started.
`bun run gates` (`scripts/check-changelog.ts`) fails a note the release step
could not read, a branch that edits what the step writes, and a change to
`plugin/` without a note that asks for a release.

The release commit is not a merge: it writes, from what a person already
merged, what that merge implies, so [ADR-0003](ADR-0003-a-person-merges.md)
holds. main's rules (a pull request with `gates` green and its threads
resolved, no force push, no deletion) live in a repository ruleset, because
only a ruleset can let one named actor past every rule: branch protection
exempts only administrators from the required checks. The ruleset names the
`jig-release` GitHub App, limited to this repository's contents, and
repository administrators, as before. The workflow mints the App's token for
the run, after the release step has written its commit, from a key held by
the `release` environment, which only main may use; no workflow on another
branch can mint one.

## Alternatives considered

- **Keep editing CHANGELOG.md, with a union merge driver**: rejected; git
  keeps both sides only in merges it runs locally, GitHub still reports the
  pull request as conflicting, the lines land without regard to sections,
  and the version race stays.
- **Generate the changelog from commits** (release-please,
  semantic-release): rejected; entries become commit subjects, and Jig's
  changelog is written for its readers and rendered on the website.
- **Changesets**: rejected for Jig; it versions `package.json` packages
  where Jig's version lives in two plugin manifests, groups entries by bump
  rather than Keep a Changelog's types, and has no Unreleased section for
  changes outside a release. It remains the mapping for JavaScript
  repositories in M12.
- **A personal access token of an administrator**: rejected; it works with
  branch protection as it was, but it is tied to one person, expires and
  must be rotated by hand, and every push appears as that person.
- **A release pull request a person merges**: rejected for now; it needs no
  actor past the ruleset, but every plugin change would wait on a
  second merge before reaching machines, against ADR-0002's one release per
  change. It is the fallback if the App is withdrawn, and would then need
  the branch check to admit the release step's own commit, which it refuses
  today.

## Consequences

### Benefits

- Open pull requests no longer conflict with each other over the changelog
  or the version, so a merge no longer costs every other pull request a
  resolution and a CI run.
- The version is chosen once, by one run on main, so no two branches claim it.
- A note is reviewed in its pull request's diff, as the changelog edit was.

### Costs

- A pull request's diff no longer shows the version it will ship as.
- Each merge adds a release commit to main, which runs the gates and deploys
  the site again.
- The `jig-release` App, its key in the `release` environment and its place
  in the ruleset's bypass list must stay in place; without them, notes wait
  on main until the workflow is run again.
- The App can push to main past every rule; what keeps that narrow is the
  key's environment, the token's one-hour life and contents-only scope, and
  the workflow itself changing only through a reviewed pull request.
- For the minute between a merge and its release commit, main carries
  plugin code under the previous version.

## Extraction (decisions-become-checks)

Checked: `scripts/check-changelog.ts`, in `bun run gates`, fails a malformed
note, an edit to Unreleased or to the set of release sections, a moved
manifest version, and a change under `plugin/` without a note that asks for a
release. The release workflow fails when it cannot mint the App's token or
push. `scripts/check-branch-protection.ts` reads main's ruleset by hand
(reading it needs an administrator's login) and reports its bypass list.

## Amendments

### 2026-10-16 — The run releases every waiting note at once (v1.1)

Touches the Decision's "It does this one merge at a time, in the order the
merges landed, so each merge that changes `plugin/` is still its own release".
The run releases the tree it checked out, which holds every merge that landed
before it started, so it writes all waiting notes as one release: the largest
bump any asks for, their notes in merge order, one commit and one tag. The
reason and the alternatives are in
[ADR-0002](ADR-0002-the-plugin-is-its-directory.md)'s second amendment.

### 2026-10-17 — One version for each run; no per-merge mode (v1.2)

The release step has no per-merge mode: when at least one waiting note asks
for a release, a run writes the notes that do as one version, one commit and
one tag, pushed together atomically; notes that ask for none go under
Unreleased. [ADR-0002](ADR-0002-the-plugin-is-its-directory.md)'s third
amendment gives the reason.

### 2026-10-18 — The tag follows the release commit's gates; the workflow runs the skill's action (v1.3)

Touches the Decision's "`.github/workflows/release.yml` runs
`scripts/release.ts`" and "commits, tags `v<version>` and pushes", and the
first amendment's "one commit and one tag" pushed together. The workflow runs
the `changelog` skill's release step through the skill's action from this
checkout (`./plugin/skills/changelog`), in a job that holds no key; a second
job, which alone reads the `release` environment and runs nothing from the
repository, pushes the release commit. The tag no longer travels with that
push: the workflow's `tag-plan` job finds each released version without its
tag, and `tag-push` tags the version's releasing commit (the first commit on
main's first-parent line whose changelog has its heading) once `gates`, the
check main's ruleset requires, has passed on that commit. A cancelled gates
run is re-run once; a releasing commit whose gates failed is left untagged
and reported. A tag on main therefore always names a commit that passed its
gates, which pushing the tag with the commit could not promise, since the
commit had passed nothing yet. `scripts/release.ts` stays the local way to
run the step (`--dry-run`). The mechanism is the skill's
([plugin/skills/changelog/README.md § How the release reaches the branch](../../plugin/skills/changelog/README.md#how-the-release-reaches-the-branch)).

### 2026-10-18 — A note only for what a team using Jig notices; corrections to Unreleased (v1.4)

Touches the Decision's "A pull request records its change as a change note"
and "It never edits the changelog's Unreleased or release sections", and the
alternative's "It remains the mapping for JavaScript repositories in M12".
CHANGELOG.md is written for the teams that use Jig, so a pull request adds a
note only when one of them would notice its change: always for a change to
`plugin/`, which reaches machines only as a new version, and never for the
website, CI, Jig's own tooling or the documents only its maintainers read
([changes/README.md § When a pull request needs one](../../changes/README.md#when-a-pull-request-needs-one)).
A pull request still never adds to Unreleased or a release section, but it
may correct or remove an entry already under Unreleased, as it may an
earlier release's text; the branch check names the edit for the reviewer.
The release practice these rest on is
[M16](../../modules/M16-releases-versions/README.md)'s, and the tools that
map it per ecosystem, Changesets among them, are in
[M16's mappings](../../modules/M16-releases-versions/mappings.md).

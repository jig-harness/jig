---
title: "ADR-0004: A pull request adds a change note; the release is written after the merge"
type: adr
status: approved
description: "Pull requests never edit CHANGELOG.md's open sections or the plugin version; a release step on main writes their change notes, moves the version and tags it"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-15
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

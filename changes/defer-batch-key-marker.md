---
release: minor
---

### Changed

- **Breaking.** `resolve-review-comments`' deferral batches are now looked up
  by a marker in the issue **description** — `<!-- defer-batch-key: repo=…
  pr=… type=… -->`, written on its own line above `## Entries` — instead of by
  the issue title. The title becomes display-only, so a batch can be retitled
  to say what it actually contains; previously the title *was* the key, matched
  by exact equality with create-on-miss, so renaming a batch whose pull request
  could still run a round minted a duplicate. The key now carries the
  repository as well, so another consumer's pull request of the same number and
  Type no longer collides: the `repoVerdict` Repo-label triage that used to
  disambiguate them is gone, and the Repo label is reconciled like Type and
  Size instead — absent is repaired, a label contradicting the marker is
  refused rather than restamped.

  **What a consumer changes:** any batch issue that is still *live* — its pull
  request still open, so a later round will look it up — needs the marker added
  to the top of its description, or that round files a second issue beside it.
  Batches on merged pull requests need nothing: no round will look them up
  again. The marker is exactly
  `<!-- defer-batch-key: repo=<your repo label> pr=<number> type=<type> -->`,
  with the repository label and Type as they appear in
  `review.taxonomy.repos` / `.types`. Once added, stop editing that line:
  rewriting or deleting it makes the batch unfindable, and so does blanking the
  description.

  Repo and Type labels used in the key must now match
  `letters, digits, . _ : @ + / -` with no whitespace — a label that cannot be
  embedded in an HTML comment on one line is refused before anything is
  written, rather than producing a malformed key. Rename any such label in
  `review.taxonomy`.

---
release: minor
---

### Added

- Any code reviewer's finding severities can be read now, not only the ones
  Jig knows. `review.severity_formats` in `.config/jig.yaml` describes a
  reviewer by login: the shape of its severity field (`bold-token`, `badge`,
  `html-badge` or `pipe-fields`) and how its words map to Jig's `blocker`, `high`,
  `medium` and `low`. The decline ladder of `resolve-review-comments` then
  works on that reviewer's findings. CodeRabbit, the Codex connector and
  Jig's own finding format are still built in, and Greptile's `P0`–`P2`
  badges now are too
  ([severity formats](../plugin/EXTENDING.md#severity-formats)). The
  bullets of a reviewer's summary comment are read with the formats of the
  login that posted it, Jig's own format among them.
- The audit's configuration check reports a `review.severity_formats` entry
  the review skills would refuse: an unknown shape, a word mapped to
  something other than Jig's severities, an empty or duplicated word list.

### Changed

- A severity is read only from comments posted by the login its format
  belongs to. Before, a bold severity word (`**high**`) or a `P0`–`P3` badge
  was read from any author. **Breaking** for a repository whose reviewer
  writes a bold severity word but is not its configured reviewer
  (`review.reviewer_app`, else `review.bots`), or writes badges under a
  login other than the Codex connector's: that reviewer's findings now read
  `unknown`, which leaves the ladder inert for them where `severity` is
  listed under `fail_open.inert_when_unknown`. Add an entry for the
  reviewer to `review.severity_formats`. The loop-metrics warning for a
  reviewer whose findings all read `unknown` now says so and names that
  field.

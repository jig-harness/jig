---
release: minor
---

### Added

- A pickup's or a follow-up's run that ends without a closing report, and whose end its wrapper cannot explain, now has the end of its transcript copied to `~/.local/state/jig/dispatch/runs/<record>/` (at most 2 MiB, credentials redacted, readable only by you), found by the session id Claude Code was given or the one a Codex pass printed. The dashboard's run line and `jig ask`'s `last.run` name the copy's path. The copy is removed seven days after the steward records the run's cause, and at the latest after `receipts_days`; Jig keeps no copy of a reported run's transcript and never deletes the vendor's files. See [plugin/README.md](../plugin/README.md#the-closing-report).
- The steward's digest lists those runs with an excerpt of each copy (the run's last assistant turns and the tool errors after its last success, as evidence), and the steward submits a new `cause` record for each: a cause from its closed list and a summary of what the run had got to. The next tick writes it onto the run's outcome row as its closing report, `by: steward`, redacted as a pass's report is. It writes no tracker state and starts no pass. See [the steward](../plugin/skills/steward/README.md).
- When a pass leaves no report, its wrapper records what it saw as the report, `by: wrapper`: a pass that could not start (`startup`, or `usage-limit` on the vendor's notice), one it stopped at its deadline (`deadline`), and every steward pass, with the cause it saw, else `unknown`.

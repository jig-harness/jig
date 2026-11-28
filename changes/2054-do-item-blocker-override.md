---
release: minor
---

### Added

- A person can start an item ahead of its open blockers, on the record:
  `tracker.ts claim <KEY> --override-blockers "<reason>"` in an interactive
  session clears a claim's blocker refusal, and a refusal of
  `do_item.preflight_command` whose second output line is `kind: blockers`,
  and nothing else. Before it writes, the claim prints the open blockers and
  what starting early risks; once it lands, it posts one comment recording
  the person, the reason, the blockers (keeping only a blocker's key when
  shared visibility is unverified) and a stable attempt marker so retries
  check trusted comments before posting and report an indeterminate outcome
  instead of duplicating a comment, carries them in the claim marker
  (`do_item.claim_marker`) and prints them as `"override"` in its JSON. The
  pull request it leads to carries a `## Blocker override` section naming
  what to merge after, as advice. A dispatched or driven session
  (`JIG_LAUNCH` set), a served or factory claim and a work-batch member's
  claim (`--work-batch`) are refused the option, and the
  [do-item skill](../plugin/skills/do-item/SKILL.md) passes it only on the
  person's own word. **Consumer action:** none.
- `do_item.override_label` names a label an overridden claim adds to the
  item; unset, none is added, and Jig never removes it
  ([configuration](../plugin/CONFIGURATION.md#do_item)). **Consumer
  action:** none.

### Changed

- A claim made in an interactive session (`JIG_LAUNCH` unset), without
  `--for`, `--factory-ancestor` or `--work-batch`, refuses an item with an
  open `blocked_by` relation, or one whose blocker cannot be read (exit 3,
  `"why": "blockers"`, nothing written, the blockers and the consequence
  statement in its JSON), as a served claim already did; one the claim
  would refuse anyway reports that refusal instead. Such a claim reads the
  item's relations and each blocker once more. Dispatched and work-batch
  claims are unchanged. **Consumer action:** advised at instructions. Where
  a runbook starts a blocked item by hand, have the person claim it with
  `--override-blockers "<reason>"` instead of removing the blocker link.

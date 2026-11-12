---
release: minor
---

### Added

- A change note's entry can say what the change asks of the people who use
  the release, as a **consumer action** after its description:
  `**Consumer action:** required at configuration. Rename the key.`, with
  the strength (`required` or `advised`), the levels (`machine`,
  `configuration`, `instructions`), an instruction of at most 400 characters
  and optional `**Detect:**` hints (`config:`, `text:`, `file:`,
  `plugin-source:`); `none.` says it asks nothing and `retracts <id>.`
  withdraws an earlier one. `/jig:changelog`'s check now refuses a malformed
  declaration in any note, and with the new `changelog.consumer_actions: true`
  it also requires one on every breaking entry a branch adds. The form is in
  the [changelog skill's guide](../plugin/skills/changelog/README.md#consumer-actions).
  **Consumer action:** none.
- `changelog.consumer_actions_record` names a file the release step derives
  from the changelog's released sections in every release: each consumer
  action with its id, for a tool to read without the changelog.
  `consumer-actions-record.ts --check` fails when the committed file is not
  what the changelog derives, and `--write` regenerates it. The plugin now
  ships Jig's own record, `plugin/consumer-actions.json`, which lists the
  actions of every release from this one on. **Consumer action:** none.

---
release: minor
---

### Changed

- **Breaking:** `tracker.ts create` and `update` now exit `3`, with only the reason on stderr, when the tracker or the repository's configuration refuses a well-formed request, such as filing an issue without a facet or a required label, a type or size the repository does not list, a sub-task as a parent, removing a Jira issue type, setting no priority on a Jira issue, or giving a label that stands for a facet, a field's value or a workflow state. These used to exit `2` and print the usage text after the reason. A malformed command line still exits `2` with the usage text, so a caller can now tell "the command was wrong" from "the change was refused". **Consumer action:** advised at instructions. A runbook or script that reads exit `2` from `tracker.ts create` or `update` as an incomplete filing or any of these refusals (label, field value, workflow state, facet value, parent) should read exit `3` instead. **Detect:** `text:tracker.ts create`, `text:refused to file`, `text:is not a type of this repository`, `text:gives a sub-task no children`.

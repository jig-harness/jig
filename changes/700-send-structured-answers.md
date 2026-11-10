---
release: minor
---

### Added

- `jig send drive@… answer <key> --approve` takes a parked decision's recommended option, and `--choose '<option>'` the option of that name, matched as the drive's readers match it; `--note '<text>'` adds a condition beside either. The dry run shows the option in full with the decision's digest and prints the command to send, which names it with `--decision <digest>`: a real send must name it, and writes nothing when the drive has framed the question again since. The comment carries the digest and the choice in its `drive-answer` record, still version 1. An answer that names no option, or two forms, is a usage error, and an option the park does not offer is refused. See [plugin/README.md § Telling a station what to do](../plugin/README.md#telling-a-station-what-to-do).
- `jig send drive@… answer --all --approve` approves every open parked item whose class Jig's table of acts lists as Decide, one comment per item, and leaves out, saying why, Authorize classes, a repository's own classes, and items with no recommendation or no digest. Its dry run prints a set token of the items and their digests, and the real send, naming it with `--decision-set <token>`, writes nothing when any of them changed.
- The `operator` skill turns "approve 456's parked question", "choose Keep" and "approve them all" into those commands, run with `--dry-run` first.

### Changed

- `jig send … answer` no longer refuses an item someone already answered. A person who answers again replaces their earlier answer, which the send shows first; another person's answer is named, with a reminder that differing answers leave the item disputed.

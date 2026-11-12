---
release: minor
---

Every need on the dispatch dashboard's Needs you is now a framed decision a person answers in a word, and the dispatcher carries out the option they choose.

### Added

- A dispatched follow-up's or pickup's pass that stops for a person frames what it asks and records it with its result: `jig dispatch result <record> <token> failed --decision <file>` takes a `parked-decision/v1` record, checked as a drive's park is, and keeps it with the result and its digest. The need it raises carries that decision; a pass that cannot frame still ends on its `Question:` line, whose words still show ([Every need is a decision](../plugin/README.md#every-need-is-a-decision)).
- For the needs the dispatcher finds itself it frames the decision from the facts that identify them, with options it can carry out: a failed follow-up (Run it again, Record it done), a stalled pickup or an unframed pickup question (Release the claim), a checkout an unlisted tree holds (Detach the checkout, only when it is idle), a drive handed to a person (Re-arm the drive), a stuck launch record (Clear the record), each with Leave it to me. The line's decisions name the station that answers them, its address and where the answer comment goes (`LineDecision.answer`), and `shared/decisions/station.ts` holds the answer format every surface imports.
- `jig send followup@…`, `pickup@…` and `drive@… answer <key> --approve|--choose <option> --decision <digest>` answer a need's decision with the same comment a person can type on the pull request or forge issue.
- The tick on the host that owns the repository reads those answers and carries out the chosen option once, after checking again that it still may (the stage is on, no hold label, the marker unchanged, no session holds the work, no open pull request carries the item, the checkout idle), and otherwise refuses with the reason the need shows. It counts only answers that name the decision's current digest, from authors the forge vouches for and never its own login. A session it starts on an answer is handed the option chosen, narrowed by the person's note. The state database gains the `station_answers` table and the launch record's `result_decision` column.

### Changed

- A need that carries a framed decision takes its act from the decision's class (the dispatcher's own framings read Decide), in place of the cause's act or a steward's proposed one.

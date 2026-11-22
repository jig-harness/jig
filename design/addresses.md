# Threads for the dispatch dashboard

`jig ask <address> --thread` shows the correspondence for one station. The
dispatch dashboard needs the pickup, drive and follow-up conversation in
one place, together with which questions still wait on a person. This is
the thread work in [plan item 42](plan.md#42-the-dispatch-dashboard-one-place-to-watch-and-steer-the-line).
The [Addresses chapter](../plugin/protocol/addresses.md) defines the
existing addresses, and the [plugin reference](../plugin/README.md#asking-a-station-where-it-stands)
explains the current thread and waiting-list commands.

## What the thread gains for the dashboard

The [dashboard](dispatch-dashboard.md#threads) shows one thread per
[piece of work](../GLOSSARY.md), across machines, and names single entries
in it. So the thread grows under `ask`'s version 1, each addition an added
field, and the answer's version stays the same. The dashboard reads the thread
through `jig ask` like any other interface and stores none of it. The thread is the first step of stage 2 in the
[dashboard build order](dispatch-dashboard.md#build-order).

- **Each entry has a stable `id`**, the same at every read, so an interface
  can point at one entry and an answer can name the question it answers.
- **A `question` carries its `key`, its `class` and a `status`.** The key
  is the one an `answer <key>:` line names. The class is the
  human-in-the-loop registry class the park names
  ([ADR-0010](../docs/adr/ADR-0010-parking-is-reserved-for-registry-classes.md)).
  The status is `open`, `answered`, `acted` (the drive acted on the answer)
  or `expired` (the park ended unanswered).
- **An `answer` carries `inReplyTo`**, the id of the question it answers,
  who answered (their forge login), and the permission evidence recorded when
  the answer was accepted. Existing receipts without that evidence say that
  the historical permission is unknown; a later permission lookup does not
  rewrite why an earlier answer counted.
- **An answered park stays in the thread while its receipt remains.** The
  drive ledger keeps recent resolved parks (`resolvedParks[]`), each with its
  key, question, answer metadata and when the re-arm cleared it. A fresh batch
  is kept whole even when it exceeds the retention target, and later ledger
  trimming can leave fewer receipts. The thread reads an answer only from the
  configured forge endpoint after confirming that its recorded URL belongs to
  this repository and pull request. It compares the fetched body with the
  receipt's retained body hash: an edit is shown as later than the retained
  verdict, and a legacy receipt without a hash reports its source text as
  unverified. A missing, unauthorized, expired or cancelled source read shows
  the answer's author, time and URL with its text unavailable. The read shares
  the thread's cancellation signal and deadline. A bounded ledger that has cut
  older receipts says its resolved-park history is incomplete rather than
  implying that none existed.
- **One thread per piece of work.** A piece of work has an address at each
  station: `pickup@` for its item, `drive@` and `followup@` for its pull
  request. `ask` folds their entries into one thread by the piece of work's
  aliases (the item key, the branch, the pull request). The aliases are
  joined from the tracker's issue links, the branch name and the pickup's
  records, and each join carries its evidence. A join counts only on
  evidence the repository's own people wrote: a pickup record, a tracker
  link, or a branch in the repository itself, never a fork's, on a pull
  request whose author is the repository's own. A pull request that matches
  only by name stays a thread of its own. Every entry keeps its own
  `from` and `to`, so the folded thread still says which station spoke. A
  work-batch's batch key joins its member items, so a batch is one thread.
  A fold that reads the tracker counts that read in `sources`, as every read
  does.
- **The threads that hold something for a person.** Beside `--waiting`'s
  addresses, `ask` lists the threads that hold an open question, an act a
  merge waits on or a follow-up's question, one entry per piece of work. A
  thread leaves the list once nothing in it waits on a person. Hiding one is
  the reader's own choice: the dashboard keeps it in that browser, and `ask`
  stores nothing for it.

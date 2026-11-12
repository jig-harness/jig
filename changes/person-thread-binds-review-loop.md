---
release: patch
---

### Fixed

- An unattended review drive no longer reverses what a person decided in a
  review thread. A bot's finding that argued against a person's ruling
  could be accepted and fixed once the person's thread was resolved,
  since the triage only looked for an earlier outcome token, and a person's
  thread answered with a plain "done" carries none. Now a person's thread,
  open or resolved, binds every later round. A finding whose fix would
  undo, narrow or contradict it goes to the review arbiter. The arbiter
  rejects it when it re-argues what the person settled, and escalates it
  under `human-thread` when it raises something the person did not settle.
  `drive-pr`'s `triage-thread.ts` refuses (exit 5) a fresh `accepted` reply
  to a bot's thread on a file that carries a person's thread, printing the
  person's words, until the arbiter's `fix-now` ruling on that thread is
  recorded with the time its context was gathered (`contextAt`) and no person has spoken or edited a comment on the file since. The triage rubric, the arbiter and M7's human-in-the-loop
  registry template say so.

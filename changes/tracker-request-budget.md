---
release: minor
---

The dispatcher stays within a tracker's rate limit: a served queue costs a
handful of requests a tick instead of one per blocker and parent, and a
spent limit stops every request on the host until the reset.

### Added

- A request budget per tracker credential, shared by every process on the
  host (`~/.local/state/jig/tracker/budget.sqlite`, keyed by a hash of the
  credential). The Linear transport reads the request and complexity
  windows from every answer; Linear's `RATELIMITED` refusal, and a Jira
  HTTP 429, mark the credential limited until the reset, and no request
  leaves the host before it: the call fails at once with the reset time.
- `tracker_share` in the machine's dispatch file: the share of each
  window the tick's own tracker reads may use (default `0.5`), leaving the
  rest to the passes it starts and to people.
- One query per served queue on Linear: the assignments with their
  relations (and each related issue's state) and their parent (with its
  description), and one batched lookup by key for the rest, such as an
  execution plan's steps.
- A tracker change probe on Linear: one request asks whether any issue the
  last reading depended on, a child of one, or a new assignment changed;
  when nothing did the reading is reused whole, and it is taken whole again
  every 15 minutes. Every repository naming the same tracker, team and
  person shares one reading per tick. A served queue of 50 assignments with
  blockers and parents costs one request on a quiet tick and two or three
  when an issue changed, where it cost about a hundred per repository.
- `jig dispatch result <record> <token> waits --until <time>`: a pickup
  pass the tracker's rate limit stopped records it, and the item starts
  again after the reset with no question for a person. Tracker scripts exit
  `5` (`RATE-LIMITED until <time>` on stderr) when the limit refuses them.

### Fixed

- A tick that meets a rate-limited tracker reports the tracker once as
  limited until the reset, keeps showing the queue it last read, and its
  pickups wait, where every served item was reported unplaced and every
  tick kept sending the refused requests.

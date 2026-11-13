# Outbound calls: design

**What problem this solves.** Jig calls systems it does not control: a
forge, an issue tracker, a store for what sessions learned. Each limits its
callers by a count of requests, by a cost per query and by the time it
spends on one request, and every process that uses a credential shares its
limits. Without one way to make these calls, each integration handles limits
and outages on its own. A query's cost goes unmeasured until it spends a
credential's whole allowance, a read that fits one repository times out on a
busier one, and a refusal that would clear by waiting fails a
[tick](../GLOSSARY.md) and asks a person. With this built, every call goes
through its system's governed transport, which reuses an answer before it
sends, stays inside a budget the whole machine shares, records what each
operation cost, and tells a reader exactly how a call failed.

This is the design of [plan.md](plan.md) item 55, decided in
[ADR-0021](../docs/adr/ADR-0021-outbound-calls-are-governed.md). Built so
far: the shared budget record for the tracker adapters
(`plugin/shared/tracker-budget.ts`, documented under `tracker_share` in the
[configuration reference](../plugin/CONFIGURATION.md)), conditional requests
for some forge reads (`plugin/shared/gh-conditional.ts`), and a deadline on
every call.

## How it works

### What each system limits

A transport declares its system's limits in a
[transport profile](../GLOSSARY.md). A profile never
holds a number the system reports: the limit, the balance and the reset are
read from each answer, since they differ by credential and plan. The
figures below are what the systems state or what a host measured, and say
what a profile has to model.

| System | What it limits | How a limit refills | How an answer reports it | How it refuses |
| --- | --- | --- | --- | --- |
| GitHub, REST | Requests an hour (5,000 for a person's token); searches a minute | Whole, at the reset | `x-ratelimit-limit`, `-remaining`, `-reset` and `-resource` headers | 403 or 429 with no requests remaining |
| GitHub, GraphQL | Points an hour, a query's points by the nodes it may return; about 10 seconds a query | Whole, at the reset | `rateLimit { cost remaining resetAt }` in the query | An error of type `RATE_LIMITED`; 502 or 504 for a query out of time |
| GitHub, secondary limits | Requests at once, points a minute, content created a minute | Not stated | Not reported | 403 or 429, or a 200 with an error body; `retry-after` when the system sends it |
| Linear | Requests an hour and complexity points an hour for a key (2,500 and 3,000,000 measured); 10,000 points for one query; a list with no page size is priced at 50 items | Continuously: the reset an answer names is a full refill away | `x-ratelimit-requests-*` and `x-ratelimit-complexity-*` headers, `x-complexity` for the query | 400 or 429 with the error code `RATELIMITED` |
| Jira Cloud | Request and cost limits that differ by authentication mode (OAuth or API token) and by endpoint | Not stated | Limit, remaining and reset headers and a reason header, where the system sends them; the profile lists which ones each authentication mode gets | 429 with `Retry-After`; the reason header tells an endpoint's throttle from a wider quota |
| Notion | A budget per connection over a fixed 60-second window, sized by plan; a limit shared across the workspace; some endpoints with limits of their own | Whole, when the window ends | Not reported | 429 with `Retry-After`; the workspace limit refuses every connection at once |

A local tool Jig runs (a workspace application's command, `git` against a
remote) has no rate limit. It gets a deadline, the failure classes and the
reader's policy, and no budget.

### The library

`plugin/shared/outbound/` holds the obligations once. Each part is moved
from code that already runs for one system where such code exists; a moved
module leaves its old path in the same pull request.

| Part | What it does | Moved from |
| --- | --- | --- |
| `profile` | A system's limits: which exist, how each refills, how an answer reports them, what a refusal looks like, and who owns the quota | Constants in each transport |
| `budget` | Admits and reserves per credential and limit, with a share for the dispatcher | `shared/tracker-budget.ts` |
| `ledger` | Totals of requests, cost and time per operation and caller | New |
| `failure`, `retry` | The closed classes; jittered backoff inside the call's deadline that honours `Retry-After`, for reads only | `tracker/read-retry.ts` and each transport's own classification |
| `cache` | Answers kept by update time or by the system's validator, stable absences included | `shared/gh-conditional.ts`, the served queue's kept readings |
| `coalesce`, `batch` | One request for identical reads in a run; reads by key in chunks | `dispatch/lib/tick-reads.ts`, the Linear read by key |
| `paging` | Page caps, and a page that shrinks when the system runs out of time | Built with step 1 |

A transport supplies its profile, how to send one request
(an HTTPS request or a run of a command-line client) and how to read a
call's cost and the limits from an answer. It names every operation it
sends (`TrackerAssignmentHistory`, `DispatchRepository`), which is the
ledger's key. The tracker interface and the forge reads keep their shapes:
the callers of an adapter do not change.

### Reuse before sending

- **Cache by what makes an answer stale.** An item's answer is kept under
  the item's update time, and a stable absence is an answer: an item whose
  history names no user is not read again until it changes. A failure that
  can clear by waiting (`unreachable`, `server-fault`, `rate-limited`,
  `too-costly`) is never kept; the caller retries it as the policy says.
  Where the system offers
  a validator (GitHub's `ETag` on REST reads), the transport sends it, and
  an unchanged answer does not count against the hourly limit.
- **Ask what changed first.** A reader that keeps a reading asks the system
  for what changed since, and reads everything only on a schedule or when
  the probe cannot tell.
- **One request for one question.** Two callers in one run that ask the
  same read share one request. Two repository configurations that read the
  same tracker team with the same credential share one queue reading.
- **Read by key in one request.** Many items go into one request, in
  chunks the system's single-request cap allows, never one request an item.

### The budget record

One record per quota owner and limit, shared by every process on the
machine (`~/.local/state/jig/tracker/budget.sqlite`, keyed by the system
and a hash of the quota owner). The profile defines the owner for its
system: the credential where each credential has its own allowance, the
user a key belongs to where a system shares one allowance across that
user's keys (Linear does). The credential's own hash stays on ledger rows
for authentication and reporting. `admit` reserves a request before it is
sent and refuses, with the time the limit clears, while the credential is
refused or the caller's share is spent; `observe` records what each answer
said of the limits. A limit that refills continuously is credited as it
refills.

GitHub joins the record with a window for each of its limits (core,
GraphQL, search). A secondary-limit refusal holds the credential until its
`retry-after`; with no header, until the wait an exhausted primary window
names, and with neither, for at least a minute, longer with each repeat
refusal. The command-line client shows headers only for `gh api`
calls. For the other subcommands the wrapper counts each request it sends
and records its cost as an estimate, marked as one; the `rate_limit`
endpoint sets the balance, and spending the counts do not explain goes to
an unattributed row, never to an operation. That endpoint costs nothing
against the primary allowance but can count against secondary limits, so
it is read at most once a tick and its requests are counted. The tick then reads
the record in place of asking `rate_limit` itself, and `load.forge_floor`
reads the same record.

The dispatcher's reads may use a share of each limit and leave the rest to
passes and people. One setting covers every system; `tracker_share` stays
readable as its older name.

### The cost ledger and what is reported

Every call adds to a ledger row: the hour, the system, the credential's
key, the operation, the caller (a tick, a pass and its stage, a person's
skill), and for that row the requests, the cost in the system's own unit,
the time and the count of each failure class. Rows are totals for an hour,
kept 7 days, in the budget database.

- The tick report has one line per system: the balance, what the tick
  spent, and its costliest operations.
- `jig budget` prints the same over the last hours, per operation and per
  caller, with `--json`.
- A quota the last hour's spending would empty before it refills raises one
  [need](../GLOSSARY.md), a class of its own in the needs registry, naming
  the operations that spend it.
- The dispatch dashboard reads the same ledger once the page shows quotas.

### Failure classes and their policies

A transport returns an [`Outcome`](../docs/adr/ADR-0012-failures-as-values.md)
whose failure code is one of these. No caller reads a status or a message
to tell them apart.

| Class | What it means | Retried inside the call | A person is told |
| --- | --- | --- | --- |
| `rate-limited` | The system refused the credential, or the budget record says the caller's share is spent; it carries the time it clears | No: nothing is sent before that time | Never for the wait itself; the low-quota need says why |
| `unreachable` | No answer: the name did not resolve, the connection failed, or the deadline passed with nothing received | Reads, once, after a jittered backoff; writes never | After the failure ledger's count in a row |
| `too-costly` | The system ran out of time on the request, or priced it above what one request may cost | A paged read asks again at half the page | When the smallest request fails: the query is the defect |
| `server-fault` | The system answered at once with a 5xx status | As `unreachable` | After the failure ledger's count in a row |
| `unauthorized` | The credential is missing, expired or refused | No | At once, once per credential |
| `not-found` | What was asked for does not exist or is not visible | No | No: an absence is an answer |
| `invalid` | The system refused the request as malformed | No | Yes: a defect in the request |

A write whose answer was lost is `unreachable` with a mark that the request
was sent: the caller reads the item again before it writes again.

### What a reader does without an answer

- A reader that keeps a reading shows it with its age, as the served queue
  does while its tracker is rate limited.
- A system that returned `unreachable` or `server-fault` is held in the
  budget record for the rest of the tick. The next tick sends one probe
  request, and reads on only when it is answered.
- A tick exits 0 when every failed read is of a class that clears by
  waiting and under its threshold. The failure ledger counts in a row per
  cause, and a `rate-limited` read does not count before its reset.
- A pass that meets `rate-limited` before it changed anything records that
  it waits until the reset, and the dispatcher starts it again then.

### Bounding what a call can cost

- Every call has a deadline, shared by its retries.
- Every list a query selects has a page size. Each query is declared with
  its name and a **cost ceiling** with a declared unit. The unit is
  objects: a path's size is the product of the page sizes along it, and the
  query's size is the sum over all its paths, sibling selections, fragments
  and repeated selections included. Where the system charges in its own
  unit (points) and its formula is computable from the query text, the
  query declares that unit and the gate computes the formula, scalar
  charges and rounding included. A ceiling is only compared with a
  quantity of its own unit, and a query costing exactly its ceiling
  passes.
- A paged read goes through `paging`: on `too-costly` it asks again for
  half the page, down to one item, and keeps the size it ended at for the
  next run.

### The gates and the lens

- `scripts/check-outbound-boundary.ts` widens `check-tracker-boundary.ts`
  to every system: a request to an outside host, or a run of a system's
  command-line client, outside that system's transport fails. The calls
  that predate the rule are listed and counted, and the count may only
  fall.
- `scripts/check-query-cost.ts` reads every declared query: a list with no
  page size fails, and so does a query whose total passes its declared
  ceiling.
- The review skill gets an integration lens, the obligations as
  questions, owed by an `integrations` area of the change-area catalog that
  matches the transports and the library.

## Build order

One pull request per step. Steps 3 to 6 change the same transport files and
are built in that order.

1. **A page that shrinks.** `paging`, and the dispatcher's pull-request
   read through it.
2. **The rule.** ADR-0021, the rule in `AGENTS.md`, this design.
3. **Failure classes and one retry.** `failure` and `retry`, which keep
   one retry for a read (the moved `tracker/read-retry.ts` permits three);
   the tracker
   transports and the forge client's wrapper return the classes; the tick
   and the passes follow the policies above.
4. **The ledger and the reports.** `ledger`; `budget` moved into the
   library; the tick's line, `jig budget`, the low-quota need.
5. **GitHub in the budget record.** Its profile; the wrapper admits and
   observes; the tick's own budget read goes.
6. **Reuse.** `cache`, `coalesce`, `batch`; the reads that repeat adopt
   them: assignment answers cached by update time, one queue reading per
   team and credential, the deferral script's tracker calls through the
   adapter, the nested page sizes of the issue and ledger queries.
7. **The gates and the lens.**

## Left out

- **A practice module** for the repositories Jig audits. Jig runs under the
  rule first; a module follows when a repository has validated it.
- **Priorities among callers beyond the dispatcher's share.** Reserving
  part of a budget for writes or for a person's skill waits for a host that
  shows one starving the other.
- **A queue.** A refused call returns at once with the time it clears. The
  callers are short-lived processes that run again; nothing holds requests
  in memory to send later.
- **The systems' webhooks.** Being told of a change costs less than asking,
  and needs an address the system can reach; the hub's design covers that
  ([control-plane.md](control-plane.md)).

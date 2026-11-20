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
[ADR-0021](../docs/adr/ADR-0021-outbound-calls-are-governed.md), which
model providers join by its amendment ([§ Model providers](#model-providers),
built by [plan.md](plan.md) item 59). Built so
far: the shared budget record for the tracker adapters and the forge
(`plugin/shared/outbound/budget.ts`, with GitHub's profile and the forge
client's admission in `github-budget.ts`, documented under `outbound_share`
in the [configuration reference](../plugin/CONFIGURATION.md)), conditional requests
for some forge reads (`plugin/shared/gh-conditional.ts`), among them the paged
REST reads a drive pass observes, revalidated page by page and shared within
an evaluation (`plugin/shared/outbound/observed-pages.ts`), a deadline on
every call, the page that shrinks (`paging`), and the ledger with its command, tick reports and low-quota need, and the failure classes with
one retry for a read (`failure`, `retry`, `hold`): the tracker transports
and the forge client's `ghCall` wrappers fail as the classes, and the tick
and the passes follow the policies below.

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
| `budget` | Admits and reserves per credential and limit, with a share for the dispatcher | `shared/outbound/budget.ts` |
| `ledger` | Totals of requests, cost and time per operation and caller | New |
| `failure`, `retry` | The closed classes; jittered backoff inside the call's deadline that honours `Retry-After`, for reads only | `tracker/read-retry.ts` and each transport's own classification |
| `cache` | Answers kept by update time or by the system's validator, stable absences included | `shared/gh-conditional.ts` (with its paged reads, `shared/outbound/observed-pages.ts`), the served queue's kept readings |
| `coalesce`, `batch` | One request for identical reads in a run; reads by key in chunks | `dispatch/lib/tick-reads.ts`, the Linear read by key |
| `paging` | Page caps, and a page that shrinks when the system runs out of time | `shared/outbound/paging.ts` |
| `hold` | A system that did not answer is not asked again in the run; the next run probes it once first | `shared/outbound/hold.ts`; the hold moves into `budget` once GitHub joins it |

The library's portable parts run on any platform, the hub's included: the
failure classes, retry, paging, the conditional request (`cache.ts`), the
budget's arithmetic (`budget-governor.ts`, with its record's shape and
snapshots), how GitHub's answers report its limits (`github-answer.ts`)
and the operation names (`operations.ts`). They import no runtime module,
read no file and run no program; an error one drops on purpose goes to the
reporter the platform installs (`shared/dropped.ts`). The machine's stores
are apart from them: the budget database and the ledger's tables
(`budget.ts`, `ledger.ts`), the `gh` runs and the `gh` client's
configuration. `scripts/check-portability.ts` holds the split.

GitHub has two transports. The `gh` command-line client carries the
dispatcher's and the skills' calls. A transport over `fetch`
(`github-fetch.ts`) carries the calls of code that runs no program: it is
given the platform's `fetch`, a token, the budget's governor, the held
bodies and the ledger's recorder, and keeps each obligation through them.
Both pass the same contract tests
(`shared/__tests__/outbound-transport-contract.ts`).

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
  The dispatcher reads **trackers first, repositories second**: before a
  repository derives its pickups, it groups the tracker scopes and people
  its repositories need. A scope identifies the adapter, instance,
  credential and team or project (the target repository for GitHub).
  Its reading holds the tracker's own states, labels and fields. Each
  repository applies its own state and facet configuration to that reading;
  different configurations never require another queue read. Assignment
  history, relations and open children are shared facts of the scope too.
  The kept queue reading is per scope and person, with one change probe
  and scheduled full read, and every repository shows the age of that
  reading when the scope cannot be reached.
  Native queue queries ask for the union of the repositories' needed
  states, so sharing does not pull in historical completed assignments.
  Where an adapter cannot identify an opaque command-line credential,
  its scope and cache stay in process memory: repositories share within
  the tick, and no queue, item or pool reading is written to persistent
  storage for a later login to reuse.
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
the record in place of asking `rate_limit` itself, and asks only when no
answer has reported the core window in the last minute, whatever answers
reported the other windows; `load.forge_floor` reads the same record. A
GraphQL request sent over HTTPS instead of through the client (with
`JIG_GITHUB_GRAPHQL_URL` set) is admitted and recorded as a `gh api graphql`
call is, under the record of the token it sends.

**GitHub's quota owner.** GitHub counts its primary limits per user across
every personal token of that user (classic or fine-grained), and per
installation across every token of an installation, so the record is the
owner's, never the token's. A credential keeps two keys:

- the credential's own, a hash of the token, or for the client's stored
  login of the host, the configuration directory and the account the
  client's `hosts.yml` names as active there (a local read, no request),
  so an account switch starts from nothing the previous account learnt.
  It keys ledger rows and every cache of answers: two tokens of one user
  may read different repositories, so neither reads the other's cached
  answers;
- the quota owner's, a hash of the host and `user:<numeric id>` or
  `installation:<numeric id>`; the numeric id, since a login can be
  renamed. Admission and observation use it.

A user's credential is asked once who it is (`GET /user`, run directly with
a 10-second deadline so it is not governed against the owner it is finding,
admitted against the unverified record below and counted in the ledger).
The machine keeps the answer in the budget database for every process: a
week for a token, whose user never changes, a day for a stored login. An
installation token cannot name its installation (no request answers its
id), so its owner is the installation its issuer declares beside it
(`JIG_GITHUB_INSTALLATION_ID`), on the host it is used on: a replacement
token after expiry keeps the record and its hold.

**Several GitHub accounts on one machine.** A token per repository, or a
client configuration directory per repository, is keyed apart already: each
is its own credential and is asked who it is. A client that picks its
account per repository with the stored login (a `gh` wrapper that, with no
token in the environment, chooses among the stored logins by the repository
a command addresses) sends one credential as several accounts, so the
stored login's owner is asked and kept per repository a call addresses: the
`-R`/`--repo` value, else a positional repository-page URL, else a `gh api`
route under `repos/<owner>/<repo>`, else `GH_REPO`, else the repository
`gh repo set-default` chose, else the `origin` remote, of the call's working
directory (two local `git config` reads, each bounded at 2 seconds and
reused for 30 seconds). The pages of a paged read keep the first page's
repository. The question
is asked with `GH_REPO` set to that repository and from the call's working
directory, so the client picks the account it picks for the call; it costs
one `GET /user` a day for each repository the stored login addresses. A
call that addresses no repository keeps the credential's own mapping, and a
token's mapping has no repository, since a token names its own user. A
rate-limit refusal whose text names another user than the owner the call
was admitted against ("rate limit exceeded for user ID N") is held on that
user's record, the call's reservation given back to the other, and the
mapping is asked again at the next call. A call the record refuses says
whose allowance is spent: the GitHub account, the installation, or the
host's shared record below.

**When the owner cannot be established** (the question failed or waits to
be asked again, an installation token with no declaration, an answer that
does not read), the credential is kept under one record per host that every
such credential shares. Those credentials can then only spend less than
their allowances together, never more, and a hold seen there holds every
one of them on the host. A failed question is asked again after 15
minutes, never on every call; an owner verified before stays in use while
it is asked again. There is no record of the credential's own to fall back
to: a rotated installation token would otherwise start with a fresh budget
and no hold.

**Records an earlier release kept.** Records kept under a credential's own
key stay as they are, readable by the release that wrote them; nothing is
deleted. The first time an owner's record is used, it is seeded from the
credential's earlier record (for the stored login, the earlier key had no
account in it), and an existing owner's record has it merged in, once a
process. Merging is conservative and never drops an active hold: the later
hold, the higher count of refusals in a row, and for each window the lower
balance when both name one reset, else the one with the later reset.

**A paged `gh api --paginate` read** is charged per page. When its output
is captured whole and the budget is on, the wrapper sends the pages itself
(`plugin/shared/outbound/gh-paginate.ts`): each page is admitted, observed
and recorded in the ledger as a request of its own, the next page named by
the answer's `Link` header (REST) or the first `pageInfo` cursor (GraphQL),
and the output assembled as the client prints it. A page the record
refuses ends the read as `rate-limited`, the pages already sent staying
charged, so a long read cannot pass the dispatcher's floor; a failing page
ends it with that page's failure; the pages share the call's one deadline,
unless the caller names a longer bound for the whole read (`pagedWholeSec`,
which a head's check-runs listing does), when each page keeps that deadline;
past 100 pages the read fails as `too-costly`. A form the wrapper does not
reproduce (streamed output, GraphQL with `--jq` or `--template`, the
caller's own `--include`, `--input`, or REST fields without `GET`) is left
to the client to page, after reserving 10 requests (or points) above the
floor; it keeps them and is charged them as an estimate.

The dispatcher's reads may use a share of each limit and leave the rest to
passes and people. One setting covers every system; `tracker_share` stays
readable as its older name.

### The cost ledger and what is reported

Every call adds to a ledger row: the hour, the system, the credential's
key, the operation, the caller (a tick, a pass and its stage, a person's
skill), and for that row the requests, the cost in the system's own unit,
the time and the count of each failure class. Rows are totals for an hour,
kept 7 days, in the budget database.

Where a transport knows the repository a call addressed, the row's part
that repository took (its requests, cost, unknown costs and
`304 Not Modified` answers) is kept in a table beside the row,
`outbound_cost_repository`, for the same reason as the quota table. The
`gh` path reads the repository from the command line alone: its
`-R`/`--repo`, a `repos/<owner>/<repo>` route, a GraphQL request's
`owner` and `name` variables, else `GH_REPO`; the `fetch` transport takes
it from the call or its route. What a row holds beyond its repositories'
parts, and a row without any, is spending on no known repository.

A GitHub row also names the quota owner's key and the window of the
owner's record it spent (core, GraphQL, search, none, or unknown), in a
table beside the rows so a release that writes the row's columns by
position still writes it. The window is taken from evidence: the limit the
answer's `x-ratelimit-resource` header names, else the `gh api` route,
else a table of the subcommands Jig runs and the API each mainly spends
(`gh pr view` and `gh issue list` GraphQL, `gh run list` and `gh label
create` core); a subcommand the table does not know is unknown, never
guessed. The forecasts and reports read each row's window and match it to
its owner's balance; a row written before owners were kept is matched by
its credential, or the owner the machine has since learnt for it, and its
window is inferred from its unit and operation and marked as such.

- The tick report has one line per system: the balance, what the tick
  spent, and its costliest operations.
- `jig budget` prints the same over the last hours, per operation, per
  caller and per repository, with `--json`.
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

For a model provider, `too-costly` also means the account's credit is
spent, and its policy differs: see [§ Model providers](#model-providers).

A write whose answer was lost is `unreachable` with a mark that the request
was sent: the caller reads the item again before it writes again.

### Model providers

A model provider is the fourth kind of system under the rule: it limits its
callers, charges for use and refuses a caller whose credit is spent. It is
unlike the forge and the trackers in one way that shapes everything below.
**Jig does not send the model requests.** A harness
([ADR-0026](../docs/adr/ADR-0026-the-agent-harness-is-an-interface.md))
sends them, many to a pass, from inside a session Jig started. What Jig
governs is the *launch*: whether a pass may start on a provider account, what
it may spend, and what it cost. The one request Jig sends itself is the
[offline measurement](provider-accounts.md#measuring-a-fast-decision-model)'s
call to a provider, and that call goes through a transport built from the
library like any other.

**What a provider limits.** The limits differ by provider and by the account's
plan, so a profile models them and holds none of their numbers.

| System | What it limits | How a limit refills | How an answer reports it | How it refuses |
| --- | --- | --- | --- | --- |
| A model provider, by API key | Requests and tokens a minute; for a prepaid provider, a credit balance; for a postpaid one, a spending limit the account holder set | A rate limit refills continuously or at a window's end; a balance refills only when a person adds credit | Rate-limit headers where the provider sends them; a usage block in each answer, with the cost where the provider reports it | 429 with `Retry-After` or a reset header for a rate limit; 402 for credit spent |

**The failure classes, for a provider.** A harness implementation maps what
its program reports of a provider's refusal to the closed classes, so the
dispatcher never reads a status or a message to tell them apart:

- **402 is `too-costly`: the account's credit is spent.** It is not retried,
  since waiting does not clear it. The dispatcher parks that provider account,
  raises one [need](../GLOSSARY.md) that names the account, and starts no pass
  on it until a person clears the park. A second account of the same provider
  keeps launching: the park belongs to the account, never to the provider or
  the host.
- **429 is `rate-limited`, with the time it clears.** It is retried: a pass
  that meets it before it changed anything records that it waits until the
  time, and the dispatcher starts it again then, as for any rate-limited
  class. It is never an unknown wall, and it raises no need for the wait
  itself. Where the provider names no time, the wait is the library's, at
  least a minute and longer with each repeat.
- **The account's own spend cap is a `rate-limited` refusal too.** The
  [cap](provider-accounts.md#the-spend-cap) is the caller's share, and a
  spent share is refused with the time it clears: the next day boundary for
  the daily cap. The need raised when the cap is reached says which cap.
- `unauthorized`, `server-fault`, `unreachable` and `invalid` mean what they
  mean for any system. A stop the harness implementation cannot classify
  stays a pass failure, as before; it is never recorded as a wall.

**Admission happens per launch.** A launch on a provider account is admitted
before it starts, in this order, and the first refusal ends it:

1. The repository's [provider allow list](provider-accounts.md#the-provider-allow-list)
   names the account's provider. A launch that would send a repository's
   code to a provider the list lacks is refused, and nothing is reserved.
2. The account is not parked, and its credential reference resolves.
3. The day's remaining cap covers the reservation: the per-run ceiling when
   the account has one, else the account's configured reservation (the
   account's mean pass cost over its last 20 passes, else one tenth of the
   cap). The budget record holds the reservation, as it holds a request's.

A pass that ends gives back its reservation and the budget record takes the
cost the harness reported. A pass that ends with no report keeps the full
reservation for the day and is recorded as unknown, never as free.

**A usage report becomes a ledger row.** Each harness implementation reads
its program's usage output at the end of a pass (and a transcript's usage
blocks where the program writes no summary) and returns the input and output
tokens, the cost the program or the provider reported, and the model. One
ledger row is then added or increased, in the same shape as every other
system's:

- the system is `model-provider:<provider>`, the credential's key is the hash
  of the account's identity ([provider-accounts.md](provider-accounts.md#the-identity-of-each-kind-of-account)),
  and the operation is the stage that ran (`DrivePass`, `Pickup`, `Steward`,
  `Measurement`), the key the cost report groups by;
- the caller is the dispatcher's tick, or the person's skill that started the
  pass;
- the requests are the model requests the program reports, else 1 for the
  launch; the cost is in micro-dollars (millionths of a US dollar), as whole
  numbers like every other unit; the time is the pass's own.

**Where the provider reports no cost, the cost comes from a configured
price.** The account's `prices` give dollars per million input tokens and per
million output tokens for each model it may run, and the row is marked as an
estimate, as the `gh` wrapper marks its own. For example, Gemini 4 Neon costs
$3 per million input tokens and $15 per million output tokens on the Gemini
API (blog.google, read 2026-11-20): a pass that read 400,000 tokens and wrote
40,000 is $1.20 for the input and $0.60 for the output, $1.80 in all. A model
with neither a reported cost nor a price is recorded with an unknown cost and
the account's day counts it at the reservation; the dispatcher shows the
account as `cost unknown` so a person adds the price.

**What is reported.** `jig budget` and the tick report add a line per
provider account: the day's spend against the cap, the passes it paid for and
the costliest stages. A cap the last hours' spending would pass before the
day ends raises the same low-quota [need](../GLOSSARY.md) the other systems
raise, naming the stages that spend it.

**What a reader sees of an account.** A pass whose account is parked or
over its cap does not start, and the dispatcher's reading shows the account's
state and the time it clears. A pass is never moved to another provider's
account on its own: only an account of the same provider and harness, which the
repository's list already allows, takes a launch an account's park or cap
refused.

### What a reader does without an answer

- A reader that keeps a reading shows it with its age, as the served queue
  does while its tracker is rate limited.
- A system that returned `unreachable` or `server-fault` is held for the
  rest of the tick (`hold`, kept in the dispatcher's state directory for
  the next tick). The next tick sends one probe request, and reads on only
  when it is answered.
- A tick exits 0 when every failed read is of a class that clears by
  waiting and under its threshold. The failure ledger counts in a row per
  cause, and a `rate-limited` read does not count before its reset. A
  read a turn makes for one item (a pull request's comments, a parked
  drive's thread, a base branch's head, a claim marker) carries its call's
  class on the item's row and counts the same way; one that answered but
  does not parse carries none and fails the turn.
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

One pull request per remaining step.

- **The gates and the lens.**

## Left out

- **A practice module** for the repositories Jig audits. Jig runs under the
  rule first; a module follows when a repository has validated it.
- **Priorities among callers beyond the dispatcher's share.** Reserving
  part of a budget for writes or for a person's skill waits for a host that
  shows one starving the other.
- **A queue.** A refused call returns at once with the time it clears. The
  callers are short-lived processes that run again; nothing holds requests
  in memory to send later.
- **Webhooks to each host.** Being told of a change costs less than asking,
  and needs an address the system can reach, which a host does not offer.
  The hub takes the forge's and the tracker's webhooks as its main feed for
  every enrolled host, and its forge and tracker calls go through these
  transports over `fetch`, with the library's portable parts split from
  its machine stores
  ([control-plane.md § The world view](control-plane.md#the-world-view-events-first-reconciled)).

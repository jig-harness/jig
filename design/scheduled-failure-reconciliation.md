# Scheduled-failure reconciliation: design

**What problem this solves.** A scheduled check needs to reach an owner when
it fails without creating a ticket on every run. A reusable
[reconciler](../GLOSSARY.md) would
maintain one issue per cause, announce suppression during a persistent
failure, and close the issue when a later check proves recovery.

This is future work under [the plan](plan.md#later). The doctrine is in
[M11](../modules/M11-process-observability/README.md#scheduled-failures-one-issue-per-cause);
no reconciler, new configuration fields or tracker adapters ship with this
design. It must be reviewed before implementation
([the design review rule](README.md#review-before-building)).

## How it works

### Evidence and classification

The test job emits a bounded, structured result: repository and check
identity, affected scope, immutable observation identity and ordering, checked
revision, completion status, coverage and findings with evidence links. It
calls neither a model nor a tracker. A separate triage step validates this
result and classifies each finding as regression, intended change, flake or
environment, with its reasoning. Unclassifiable or incomplete input is an
error visible in CI; it is not an empty successful result. A model may assist
classification, but cannot invent check coverage or recovery evidence.

The normalized cause fingerprint includes a version for its normalization
rules, repository, check or established common prerequisite, scope and failure
signature. It excludes run IDs, revision hashes, timestamps, generated resource
names and transient log values when they do not identify a distinct cause.
Keep the sanitized evidence ([below](#evidence-handling)) beside the
normalized identity so a mistaken grouping can be corrected. Classification is mutable triage, not part of identity:
changing a finding from environment to regression must not file it again.
Define migration of existing identities before changing normalization rules.

### Evidence handling

Logs and test output can carry credentials and personal data. Evidence
passes a sanitizer before it is stored, given to a model or written to a
tracker, so the reconciler never holds unsanitized output. What the sanitizer
removes is the consumer's, but a sanitizer is required: without one, triage
fails visibly rather than storing raw output. Store bounded excerpts and links
to the CI run's own logs, which keep that provider's access control and
retention, rather than copies of whole logs. Each stored observation records
when it expires, and a scheduled pass deletes expired evidence from durable
state while keeping the fingerprint, issue ID, streak and breaker state the
lifecycle needs. The retention period is a consumer value.

### Durable per-cause state

Store the exact fingerprint, canonical issue ID, ordered observations,
processed observation IDs, failure streak, breaker state, last confirmed
recovery, and pending tracker operations. State lives outside an ephemeral
runner; choose its backing store when moving a validated implementation.
Labels, owners, team/project, states and N remain consumer values, read through
Jig's shared configuration reader if this becomes a plugin skill. Do not add
unused configuration fields now.

Each cause advances independently. A failure opens or reopens its canonical
issue. Recurrence adds evidence until the Nth consecutive failure, which
announces suppression; N = 1 announces on opening or reopening. Further
failures update the durable ledger without tracker comments. A completed
observation covering that cause and proving it absent posts recovery, closes
the issue and clears the streak and suppression. Unknown evidence leaves
both untouched: missing, skipped, cancelled, partial, or blocked checks do
not reset the streak or close the issue. When one prerequisite prevents a
check from running, report that prerequisite's failure and leave the check's
other causes unresolved. A new cause is never suppressed by another's
breaker. A person closing a still-failing issue does not prove recovery;
reopen it while retaining its streak and suppression state.

### Tracker interface and retry safety

Call the existing
[`Tracker` interface](../plugin/skills/do-item/scripts/lib/tracker/port.ts)
through its configured adapter. `searchIssues` with `includeClosed: true`,
followed by `getIssue` and exact fingerprint comparison, locates identity;
`createIssue`, `updateIssue`, `postComment`, `listComments` and `transition`
provide writes and verification. The existing Linear adapter is the initial
implementation. GitHub Issues and Jira remain mappings until an operated
adapter is moved behind the same interface. The
[M10 external-preconditions reconciler](../modules/M10-environments-deploy/reference/external-preconditions/)
keeps one issue per registry behind its own tracker port with a GitHub Issues
adapter; before implementing, decide whether this reconciler reuses that port
or the shared interface, so Jig does not keep two tracker abstractions for
the same operations.

The interface does not promise atomic creation, unique fingerprints or
idempotent comments. A durable lock keyed by repository and fingerprint must
coordinate all triage runners, with [fencing](../GLOSSARY.md) against an
expired owner writing after a replacement acquired the lock. Serialize
observations in source order;
reject a stale recovery after a newer failure. Reserve an operation in durable
state before writing, with an exact operation marker in the issue or comment.
After a timeout, read back and verify that marker before retrying. A replay of
a processed observation performs no write and adds no failure to the streak.
Search is not a uniqueness constraint: recheck under the lock and account for
provider search visibility delay before retrying an ambiguous create.

Use a durable operation journal to resume a crash between tracker mutation
and state commit. Persist known issue IDs and verify creation outcomes by ID
when available; an unresolved create timeout pauses that cause for
reconciliation rather than blindly creating again. If the existing interface
cannot establish a write's outcome, design its smallest necessary extension
and conformance tests before shipping that write. Conflicting canonical
issues require a visible repair, never silently choosing one from a partial
search. A failed or truncated read, failed write or lost lock fails triage
visibly without acknowledging the pending observation as processed. Keep
other causes progressing when their independent state can be handled safely.

## Build order

- Move a validated consumer implementation, its tests and durable-state
  contract here, retiring its consumer copy in the same rollout. Choose a
  plugin skill if skills run it, or an M11 reference if they do not.
- Reuse the tracker interface and Linear adapter; add only the operation
  support needed for verified retries. Test duplicate observations, concurrent
  first failures, ambiguous create/comment timeouts, crashes, out-of-order
  recovery, partial evidence, independent causes, N = 1, suppression,
  recovery followed by recurrence, a planted secret that reaches neither the
  state, the model input nor the tracker, and expired evidence deleted. Prove
  the tests fail before trusting them.
- Wire evidence-only collection and separate triage in a consumer, with its
  labels, ownership and threshold policy. Observe a persistent failure and a
  genuine recovery, then document the supported invocation and configuration
  and score the existing M11 audit criteria against that evidence.

## Left out

Repairing the product, approving intended changes and provider-specific
browser classification remain outside this reconciler. The retention period
and the sanitizer's rules are consumer values; the sanitizing and deletion
steps [above](#evidence-handling) are part of the reconciler. The heartbeat still detects schedules that stop;
absence of a result is never scheduled-failure recovery.

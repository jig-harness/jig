# Driving any pull request from anywhere, with autonomy that fits the hour: design

**What problem this solves.** A pull request should reach its merge decision
without a person watching the agent that drives it. The review drive already
goes most of the way. It runs from any checkout and restarts itself from the
stops it can recover from. A drive whose driver died or stopped making
progress is taken over. Its resumable state lives on the pull request, so a
drive in another clone picks it up. It stops for a person only on a
configured human decision class, and hands over a framed decision. What is
left concerns the hours nobody is there to ask. Without it, a drive that
meets a decision outside the registry's classes at night still decides only
what `unattended` allows, and escalates the rest. A person wakes up to
drives that stopped early, with no single place that says what was decided
overnight and what is waiting for them. And the policy that bounds all of
this is read from the pull request's own working tree, so a pull request
that edits it changes what its own drive may decide.

With this built, a repository can raise how far an agent decides on its own
during the hours nobody is there to ask. Every decision taken that way is
marked provisional where it was taken, so a person can reverse it before the
merge. A morning report lists what happened overnight, provisional decisions
first. The policy itself comes from the base branch, so only a merged change
widens it. This is admissible because the one irreversible act, the merge,
stays with a person ([ADR-0003](../docs/adr/ADR-0003-a-person-merges.md)).

This is the design of [plan.md](plan.md) item 32. Most of its build is
done, and the documents that describe it are the current truth:

- driving from any checkout, the self-restart, the re-arm and the takeover,
  in [`drive-pr`'s README](../plugin/skills/drive-pr/README.md#which-working-tree-drives-it)
  and the sections after it;
- the drive ledger on the pull request, one comment the driver regenerates
  beside append-only takeover claims, in
  [§ Where its state lives](../plugin/skills/drive-pr/README.md#where-its-state-lives);
- the `autonomy` section's `attended` and `unattended` levels, the ceiling and
  the park classes, in
  [CONFIGURATION.md § `autonomy`](../plugin/CONFIGURATION.md#autonomy);
- the framed park, reserved for the configured classes
  ([ADR-0010](../docs/adr/ADR-0010-parking-is-reserved-for-registry-classes.md));
- a review bot's transparent follow-up, in
  [CONFIGURATION.md § `review`](../plugin/CONFIGURATION.md#review);
- deferral without a tracker, in the
  [deferral protocol](../plugin/skills/resolve-review-comments/references/deferral-protocol.md#deferral-without-a-tracker).

This design holds what is not built: the policy read from the base branch.
`wide`'s column with its provisional decisions, the off-hours windows and the
morning report are built and ship opt-in, unvalidated (see below). When the
policy step is built, this design leaves the folder ([README.md](README.md)).

## How it works

### The policy comes from the base branch

The ceiling `max_level` and `park_classes` are a control plane: they bound
what every agent in the repository may decide. Today the shared reader takes
them from the repository's `.config/jig.yaml` in the working tree, which for
a drive is the pull request's own checkout. A pull request that raises the
ceiling or drops a park class therefore changes what its own drive may
decide, before anyone has approved the change.

The reader takes both from the pull request's **base branch** snapshot
instead: the boundary the review skill already draws for independent review.
It ignores a `JIG_OVERLAY` redirect and the working tree's copy for these two
fields, and for every input the ceiling falls back on: when the base omits
`max_level`, the ceiling is the base's own `level`, else `attended`, never the
working tree's `level`. A pull request that edits them takes effect after it merges. When the
snapshot cannot be read the reader fails closed. The ceiling becomes
`attended`, and no decision is taken unattended until the policy reads,
since a default class list could be weaker than the repository's own:
everything that would be decided is parked as a human decision. A session
with a person in it, rather than a driver pass, reads the policy as it does
today: the person is there to see what it says.

### `wide` and the off-hours windows

The `autonomy` section gains a schedule. It is read through the shared
reader at every decision point rather than once, so a window that opens
mid-drive applies to the next decision.

```yaml
autonomy:
  level: attended            # the default: attended | unattended | wide
  max_level: wide            # the ceiling this repository allows any layer to choose
  off_hours:
    level: wide              # the level during the windows below; unset: off_hours is off
    schedule:                # default once off_hours is on, in the machine's local time
      - "Mon-Fri 20:00-07:00"   # a window may cross midnight
      - "Sat-Sun"
      - "Mon 00:00-07:00"       # Sunday night, which the two above leave out
```

The effective level is the chosen level, or the off-hours level inside a
window, capped by `max_level`. An explicit choice in the environment layer
wins over the off-hours level, so `attended` set for one run stays `attended`
inside a window. Precedence between the other layers is the configuration's
usual one, the higher layer overriding the lower. The line the drive prints
at the start of every round says when a window raised the level.

`wide` and `off_hours` are dials no working repository has validated yet.
Jig's rule keeps such dials out until one has; a maintainer decided to ship
these two now, opt-in and documented as not yet validated, as a recorded
exception to that rule. The exception is revisited once a working repository
has run them for a month against the measure below.

What `wide` adds, per decision. The decision classes the human-in-the-loop
(HITL) registry reserves are not on this table, and no level changes them.
The `attended` and `unattended` columns are what is built, as
[CONFIGURATION.md § `autonomy`](../plugin/CONFIGURATION.md#autonomy) states.

| Decision | `attended` | `unattended` | `wide` |
|---|---|---|---|
| A technical choice `decide` would rule underdetermined | A spike issue naming the missing evidence | Gather the evidence within the round's budget, then apply the ladder; a call still unsettled is `escalated` | Same as `unattended` |
| A technical choice `decide`'s last row would escalate: no sensitivity flag, no stakeholder category, no persisted-data or published-contract consequence | `escalated` | `escalated` | Decide, marked provisional |
| A bot-review thread the arbiter rules `escalate` with no registry class and no recorded human decision behind it | Park under the class `escalated` | Same | Reply with a provisional outcome and the rationale, resolve, list it in the morning report |
| Re-arm after `HITL_PARKED` with parked items still unanswered | Never | Never | Once every unanswered item is provisionally decided, where its class allows it |

### Provisional decisions

**Provisional** is a mark on a recorded decision, not an outcome token of its
own: it qualifies a reply outcome (`rejected`, `wont-fix`, `deferred`) or a
`decide` ruling recorded in the decision record format. A provisional
decision never produces a fix, so it never grows the diff, and the size
budget stays mechanical. It is marked as such in the thread reply or the
decision comment and in the ledger's decisions section, listed first in the
morning report, and skipped by `reconcile-replied-threads.ts` and by triage,
so a person's reversal is not undone by the next round.

The reversal is a comment on the thread or the decision record by an owner,
member or collaborator. The next round reads it as a human thread and parks
it under `human-thread`; it never re-decides it. An unresolve alone, which
the [forge](../GLOSSARY.md) (the service that hosts the pull request) records
without an author, is not a reversal. Provisional is admissible because the
merge is still a person's: it changes a draft the person will read, never
what is released.

The measure that validates `wide`: the share of provisional decisions a
person reverses before the merge, over the first month a repository runs it.
Only a decision whose pull request has merged or closed counts, since only
then has a person had the chance to reverse it; a decision on a pull request
still open is left out of both the count and the share until it does. With at
least ten counted provisional decisions and fewer than one in ten reversed,
the dial is documented as available. With fewer decisions, or
more reversals, the arbiter's `escalate` was right or the sample is too thin,
and the dial stays dark.

### The morning report

`drives.ts --report [--since <time>]` covers every pull request this
clone's state knows, plus every open pull request the account authored or
drove, found through the forge's search for the ledger marker. For each,
since the given time (by default the last report), it says: its terminal
state and what it means for the person; the provisional decisions, first;
the takeovers and re-arms; the parked decisions in their framed form; the
issues filed; and the deferred entries not yet filed, including those in a
closed pull request, found through the `## Deferred` section's hidden
markers. It is the one thing a person reads after an unattended night. A
person runs it, or a scheduler the repository sets up. Where a repository
has a pre-merge follow-up step, that step's list includes the pull request's
provisional decisions.

### Observability and tests

`loop-metrics.ts` counts, per pull request, the self-restarts by cause, the
re-arms and takeovers, the provisional decisions and their reversals, and
the transparent follow-ups. The validation measure for `wide` is read from
it. The tests cover a window crossing midnight, an environment override
inside a window, a reversal read back as a human thread, and the base-branch
reader failing closed, with the fake forge the drive suite already uses.

## Build order

Steps 2 to 5 are built, save the base-branch policy step 4 named; that is
what remains.

1. **The policy from the base branch.** `max_level` and `park_classes` read
   from the pull request's base-branch snapshot at every decision point a
   driver pass reaches, the fail-closed fallback, and the tests for both. It
   ships on its own, as the part of step 4 not yet built.

## Left out

- **The merge, the release, the reviewer's posture and the next item** stay
  a person's. A dark factory with no person at the merge is a different
  doctrine
  ([plan item 9](plan.md#9-delegated-merge-pull_requestsmerge-auto-on-converged)
  has the conditions); this design makes the night productive up to that
  decision, not past it.
- **A lock shared across clones.** The forge has no primitive for one. The
  ledger's append-only takeover claims are the arbitration; they hold once
  every driver reads the ledger, and not before.
- **Reading a session's context usage.** The handoff dial stays
  agent-judged; nothing here measures it.
- **Pacing against a usage window in advance.** The wall is detected after
  the fact; what changed is who may pick the drive up afterwards.
- **A pass command for another agent tool.** The driver arms Claude Code's
  pass only.

## Review

Reviewed on 2026-10-28 at commit `86abdc7` by a fresh-context reviewer
session, as an adversary. Verdict: approved for steps 1 to 4; step 5 once a
working repository has validated `wide`.

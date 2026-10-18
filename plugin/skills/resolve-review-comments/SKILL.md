---
name: resolve-review-comments
description: "Resolve unresolved pull request review threads: decide an outcome for each, fix or reply, verify, then resolve."
argument-hint: "[PR-number] [--bots-only] [--dry-run]"
allowed-tools: "Read Edit Write Grep Glob Bash(gh *) Bash(git *) Bash(bun *)"
---

# Resolve review comments

Walk every **unresolved** review thread on a pull request and drive each to one
outcome — **accepted**, **rejected**, **wont-fix**, **deferred**, or **moot** —
then **resolve** the thread. Every thread ends resolved with an audit trail;
none is ever resolved silently.

Those words are a closed vocabulary that every reply must open with. They
are parsed downstream to score the review bot, so they are a contract rather
than a formatting habit — see [Reply format](#reply-format).

This is the runnable form of the [comment-resolution loop](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) in
[M7 — PR lifecycle & review](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md).

Jig maintains this procedure and ships it as the `jig` plugin for
Claude Code and Codex, installed once per machine. Each repository supplies its
own values in `.config/jig.yaml`; consumer instructions supply
their policy, issue taxonomy and any validation or sibling sweep commands. Fix
the shared mechanism in Jig; update values in the consumer. Read
[README.md](README.md) for configuration, runtime requirements and limitations.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository whose pull request you are
working on. Never `cd` into the skill directory: the scripts find the
repository, its configuration and its sibling skills from the working
directory.

### 0. Read the consumer configuration

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/consumer-config.ts"
```

It prints the repository's values: the gate command (`gates.command`), the
expected reviewer identities (`review.bots`), the reviewer check pattern
(`review.job_pattern`) and its required checks, and the deferral team
(`review.deferral_team`). Use them wherever this procedure names them. A
non-zero exit means the repository has not configured the skill or its
configuration is invalid: report the message and stop. Do not guess values.

## Arguments

`$ARGUMENTS` — optional PR number. Omitted → the PR for the current branch
(`gh pr view --json number`).

Flags:

- `--bots-only` — act only on threads opened by a GitHub App; leave
  human-authored threads untouched. **Pass it through to every script call**, so
  enumeration and the convergence count describe the same set. Otherwise an
  intentionally-open human thread holds the count above zero forever.
- `--dry-run` — enumerate, classify, print the plan. No edits, replies, or
  resolutions.

## Why GraphQL

Thread resolution state (`isResolved`) and the resolve action exist **only** in
GitHub's GraphQL API — the Representational State Transfer
([REST](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) reviews API can neither read nor set them.
`gh pr view --comments` shows top-level conversation only and will not show you
the inline threads where nearly all review feedback lives.

The fiddly parts (paginated thread query, resolve mutation, in-thread reply) are
wrapped in `scripts/` so each pass is a deterministic command rather than
hand-written API calls.

**A diff-comment tool the workspace app provides is not a substitute, in
either case.** Some apps that wrap an agent session in a workspace offer one
(Conductor's `mcp__conductor__GetDiffComments`, for example): it is present
only in a session that app launched — never in a plain terminal pane or a
headless `/drive-pr` run — and lists comments on the workspace diff, including
ones synced from GitHub, which makes it look like a cheaper enumeration path
when it is available. It is not: such a tool does not carry `isResolved`,
cannot resolve a thread, and cannot post the outcome-prefixed in-thread reply
this loop's contract requires. A loop built on it would silently
under-enumerate, whether or not the tool happens to be present. Enumerate
through the GraphQL scripts, always.

## Workflow

### 1. Resolve the target PR

An explicit PR number — the first bare all-digits token in `$ARGUMENTS` — takes
precedence; the branch lookup is the fallback. Strip flags first so a flag is
never mistaken for the PR.

```bash
PR=""
for a in $ARGUMENTS; do case "$a" in ''|--*) ;; *[!0-9]*) ;; *) PR="$a"; break;; esac; done
PR="${PR:-$(gh pr view --json number -q .number)}"
```

Bail politely if there is no PR.

### 2. Enumerate unresolved threads

In continuous mode (driven by `/loop` or `converge.ts`), gate first: reviewers
settled and at least one unresolved thread. Run `await-round.ts` before
enumerating so each pass waits for the current round to be ready.

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/await-round.ts" [PR] [--bots-only] --once || exit
```

Exit `0` means proceed; anything else means wait or stop — see
[Continuous mode](#continuous-mode) for the full contract. A one-shot manual
invocation may skip this and enumerate directly.

Then enumerate, labelling each thread's self-inflicted status in the same
pass — step 3's decline ladder requires it:

```bash
set -o pipefail
DRIVE_PR=.claude/skills/drive-pr
[ -e "$DRIVE_PR" ] || [ -L "$DRIVE_PR" ] || DRIVE_PR="${CLAUDE_SKILL_DIR}/../drive-pr"
bun "${CLAUDE_SKILL_DIR}/scripts/list-unresolved-threads.ts" [PR] [--bots-only] \
  | if [ -e "$DRIVE_PR" ] || [ -L "$DRIVE_PR" ]; then
      bun "$DRIVE_PR/scripts/self-inflicted.ts" [PR]
    else
      cat
    fi
```

`set -o pipefail` matters here: `self-inflicted.ts` treats an empty stdin as a
legitimate zero-thread stream and exits 0, which is right when the enumerator
found nothing and wrong when it crashed after printing nothing — without
`pipefail` the pipeline's own exit code is the filter's `0` either way.

Make Bun available **before** starting the pipeline. Environment changes inside
its left-hand subshell do not reach the right-hand subshell. In a shell where
Bun is not on `PATH`, put whatever makes it available (for example
`eval "$(mise activate bash)"`) in its own preceding statement.

`DRIVE_PR` names the sibling `drive-pr` skill the same way the scripts'
sibling lookup does: the repository's own `.claude/skills/drive-pr` when one
is present, else the `drive-pr` skill beside this one in the plugin. The
`[ -e "$DRIVE_PR" ] || [ -L "$DRIVE_PR" ]` guard is
the standalone-install case, same policy as § "One refusal you may meet" below:
no `/drive-pr` installed at all means every record simply lacks
`selfInflicted`/`selfInflictedCommit`, which step 3 already treats as
`unknown` — a supported degrade, not an error. `-e` alone is not enough to
detect "installed": it follows symlinks and reports false for a dangling one,
so a broken `drive-pr` symlink (target moved or removed) would
silently take the `cat` branch — indistinguishable from a clean standalone
install even though it is the half-installed case below, not that one. `-L`
catches it: true for a symlink whether or not its target resolves, so a
dangling link still routes into the `bun` branch. A `/drive-pr` that is
installed but with `self-inflicted.ts` itself missing is the *other* case
that section names — "a half-installed sibling skill is a broken integration,
not a licence to skip" — and the guard deliberately does not paper over it:
`bun` fails loudly on the missing file, `pipefail` carries
that failure out, and the pipeline errors instead of silently degrading.

Emits **newline-delimited JSON ([NDJSON](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)), one unresolved thread per line**, already filtered and
paginated:

```json
{ "threadId": "...", "path": "...", "line": 42,
  "isOutdated": false, "url": "...", "commentsTruncated": false,
  "comments": [{ "author": "...", "authorAssociation": "...", "body": "..." }],
  "selfInflicted": true, "selfInflictedCommit": "...", "severity": "medium",
  "category": "unknown" }
```

- `threadId` is the single key for both `reply-to-thread.ts` and
  `resolve-thread.ts`.
- `selfInflicted` — `true` when the anchor line's last-touching commit is one
  of this PR's own (`self-inflicted.ts`); `false` when every line in
  range predates the PR; `null` when it could not be measured (an outdated or
  left-side thread, an unreadable base, …). Feed this straight into step 3's
  `--self-inflicted` — pass `null` through as `unknown`, never as `false`.
  `selfInflictedCommit` names the blamed commit when `true`.
- `severity` — the thread's own first comment run through `severityOf`. The
  recognised formats are a bold `**blocker**`/`**high**`/`**medium**`/`**low**`
  token opening the comment and a `[P0]`–`[P3]` image badge, read from any
  reviewer, and CodeRabbit's `category | severity | effort` header, read only
  on a comment CodeRabbit raised. A finding in any other shape reads
  `unknown`, so a custom reviewer takes part in severity-based triage by
  opening its findings with one of the first two.
  Unconditionally appended by `self-inflicted.ts` on every record,
  self-inflicted or not — feed it straight into step 3's `--severity`.
- `category` — the same first comment run through `categoryOf`. The one
  recognised format is a `🏷️ category: <token>` tag in the `·`-separated field
  right after a bold severity token on the comment's first line; every other
  finding, CodeRabbit's included, reads `unknown`. Unconditionally appended
  the same way as `severity` — feed it straight into step 3's `--category`
  and **do not omit the flag**:
  `triage-ladder.ts` refuses outright (`fail(2, …)`) when `--category` is
  omitted, rather than silently defaulting it to `unknown` — because a
  category can only ever admit a finding the ladder would otherwise decline,
  an omitted flag indistinguishable from an explicit `unknown` could wrongly
  decline a finding whose real category should have admitted it.

  Both `severity` and `category` are appended only by `self-inflicted.ts` —
  a standalone install (the `[ -e "$DRIVE_PR" ] || [ -L …]` `cat`
  branch above) never runs it, so a record from that path carries **neither**
  field at all, not `unknown`. `--severity` and `--category` are both
  required flags that refuse an omission outright, so pass `unknown`
  explicitly for whichever one is absent — the same supported degrade
  `selfInflicted` already gets above, extended to these two.
- `comments` is the thread's replies — the finding plus any back-and-forth —
  which is what you need to make the call. It is capped at 100 and **not**
  paginated: `commentsTruncated` is `true` when replies were omitted. Treat a
  truncated thread as needing a human look rather than classifying it, since the
  reply you are answering may not be the last one and an outcome may already
  have been posted.
- `url` deep-links to the comment; it is what a deferred follow-up records.
- `--include-resolved` widens the stream to resolved threads as well, each line
  carrying `isResolved`. Use it only for the reversal check in the
  [triage rubric](references/triage-rubric.md) § Contradictory findings — once
  a round finishes, the resolved thread is the only surviving record of its
  outcome. Never on a counting path: `await-round.ts` and `converge.ts` measure
  open work by line count.

Threads with `isOutdated == true` need a judgement call, not a reflex. The
anchored line moved or vanished, which often — but not always — means the
concern died with it. If the substance is genuinely gone, that is the `moot`
outcome below. If it still holds against the current code, treat it as any other
thread. Only escalate to a human when you cannot tell.

### 3. Classify and act on each thread

Before every reply, resolution, or reopening, the thread helper reads the owning
PR's current state directly from the thread identifier. It does not reuse the
round's state or a driver's target PR. Exit `5` means that PR is closed or merged;
exit `1` means ownership or liveness could not be read. Either is terminal for
this pass: stop further replies, resolutions, commits, and pushes, report the
reason, and preserve local fixes for a new delivery decision. Do not bypass the
helper with a direct mutation. This applies to one-shot, standalone convergence,
and harness loops, including replies made with `--no-outcome`.

The read runs immediately before the write, after reply validation. For a reply,
it comes before any optional driver lease check, so that check stays the last one
before the post and cannot go stale during the read. The read narrows the race;
it cannot eliminate it. GitHub
provides no open-state precondition for these thread mutations, so a PR can still
close or merge between the successful read and the mutation.

Read the thread and the anchored code. Every thread gets exactly one outcome,
and **every reply opens with that outcome in bold** — see
[Reply format](#reply-format) below. The vocabulary is closed: no other values,
no synonyms. Materiality and scope calls follow the
[triage rubric](references/triage-rubric.md); a thread the rubric does not
decide goes to the [**Review Arbiter**](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) agent
(`jig:review-arbiter`, shipped with the plugin; in Codex, see the
[Codex notes](../../README.md#codex-notes)), and only an arbiter escalation
interrupts the user. When that escalation turns out to be an **architectural**
question rather than a product/scope one — which pattern, which contract
shape, which boundary — route it through the `decide` skill (`/jig:decide`)
before interrupting: it checks the question against the repository's
architecture decision records ([ADRs](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) and standing policy first, and a finding that contradicts settled policy is answered from
the corpus rather than from the user's attention.

**`**accepted**`** — the finding is real. Before fixing, run it through the
[decline ladder](references/triage-rubric.md#the-decline-ladder): from a
configured round onward an otherwise-accepted finding must clear its band's
accept bar, and one that does not becomes `wont-fix` (or `deferred`, when the
work is obligatory) with the ladder's own reply. The bar is read mechanically —

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/triage-ladder.ts" \
  --severity <sev> --tier <1-4> --category <cat|unknown> --self-inflicted <true|false|unknown> \
  [--pr N] [--obligatory]
```

— run from the repository root with Bun available.
`--tier` is the finding's rank in the rubric's
[Priorities](references/triage-rubric.md#priorities): 1 CI pipelines and
quality gates, 2 production code, 3 docs, 4 tests (a vacuous test ranks 1).
Take it from the kind of file the finding sits on, not from the PR's overall
kind: a docs PR can draw a finding on a gate script, which is tier 1, and
the ladder declines the higher-numbered, lower-priority tiers (docs, tests)
first.
It prints the stance, the ready-to-post reply, and whether the band arms the
late-round minimal-diff rule.
`--category` is step 2's `category` label for this thread — pass it through
on every call rather than omitting it: `triage-ladder.ts` refuses outright
(`fail(2, …)`) on an omitted flag rather than silently defaulting it to
`unknown`, since a category can only ever admit a finding, and an omitted
flag indistinguishable from an explicit `unknown` could wrongly decline a
finding whose real category should have admitted it.
`--self-inflicted` is step 2's measured label for this thread's anchor — pass
its `null` through as `unknown`, never as `false`: an unmeasured anchor is
exactly the case where a regression from this PR's own earlier round could get
declined, and that measurement must not depend on an operator remembering to
run it. It fails open in every uncertain case, so an inert verdict simply
restores the rows above. Pass `--obligatory` whenever the finding is
obligatory (the boundary this section opened with) — an otherwise-accepted
obligatory finding that fails the bar must come back `deferred`, not
`wont-fix`, and the flag is what tells the CLI which template to hand back.

For a finding that clears the bar: make the *minimal* fix, then reply stating
what changed and where. **Do not resolve the thread here** — accepted threads
are held until step 5, after the gates pass. Apply the consumer's minimal-change, type-validation, and branch conventions.
If no Review Arbiter is available in this harness, preserve an undecided thread
and batch genuine policy or scope questions for the human at round end.

> **Sweep the class, not the instance — and show the sweep.** A reviewer
> reports the instance they happened to construct; its siblings are almost
> always reachable by the same search, and each one left behind costs a full
> round. A sweep run on the literal string misses the siblings that are
> **structural**. Before replying
> `accepted`, name the class the finding belongs to and search along its
> actual sibling axis:
>
> - **Same value or claim restated elsewhere** — mirror doc pairs, duplicated
>   constants, repeated examples. Use the consumer's sibling-claim sweep
>   command when available; otherwise search the superseded literal across
>   the repository. Report the hits, including an explicit zero-hit result.
>   A literal search misses reworded claims, so also search the concept and
>   inspect related summaries. Fix each sibling in the same commit or explain
>   why it is excluded.
> - **Same violation class** — when the finding cites a guardrail or rule,
>   grep the whole diff for the *pattern class*, not just the anchored file.
> - **Structural siblings** — the other branches of the same conditional, the
>   other call sites of the same constructor/macro, the fail-open mirror of a
>   fail-closed guard, every other `continue`/early-return touching the same
>   state variable.
> - **Repo-wide, all extensions** — for identifier retirements and doc-literal
>   fixes, the search is never scoped to changed files: stragglers hide in
>   `.md`, `.yaml`, `.sql`, and generated prose.
> - **Derived artifacts** — for claim retirements, sweep what a literal grep
>   cannot find: paraphrases (search the concept), summaries and frontmatter,
>   lifecycle/archive triggers, computed totals, and decision or substitution
>   clauses that consume the retired claim.
>
> The sweep must leave an **artifact**: put the search you ran and its hit
> list in the reply, each hit fixed in the same commit or explicitly excused.
> A sweep with no artifact is indistinguishable from no sweep.

> **Writing a validator over "each" member of a set? Derive coverage from the
> canonical source — never hand-list.** When the fix validates, transforms, or
> handles every member of a set the codebase already defines elsewhere — an
> exported `const` array/object, an enum, a discriminated union's variants —
> iterate that export (or exhaustively switch over the union, or assert
> coverage against it) rather than writing member names out by hand in the new
> code. A hand-picked subset reads as complete to its own author and to the
> round that reviews it; the member left out is found later, at the cost of a
> full extra round (e.g. validating only the array-shaped members of an
> exported field set leaves its object-shaped member unvalidated). This mirrors
> how generated change-area and tracker-label projections read their canonical
> catalog instead of duplicating a hand-maintained join.
> When no machine-readable canonical set exists to iterate (a hand-verified
> CLI-flag allow-list, say, with nothing in this repo to `import`), a scoped,
> source-verified list with its residual risk disclosed in a comment is the
> least-bad alternative — that disclosure is what distinguishes it from a
> silent hand-list presented as complete.

> **The source of truth is often not an exported array — derive the whole
> coverage argument from the real boundary.** Apply the same rule before adding
> a reviewer-named case to any validator, recognizer, test, budget, or prose
> claim:
>
> - A filesystem population comes from the glob or directory read itself:
>   enumerate it once and assert that every discovered member is accounted for.
>   Do not make a hand-maintained census that can drift from `readdir` or the
>   glob.
> - For a closed object, route, row, or serialized record, centralize the
>   operation at its boundary: validate it with its schema once, assemble every
>   field through one encoder, or derive the unsafe fields by excluding the
>   narrowly proved-safe subset. Do not add one field or call site per round.
> - For a union or finite collection, check both coverage *and the quantifier*:
>   use an exhaustive switch or coverage assertion, then ask whether the
>   invariant needs **every** member rather than merely **some** member.
> - Before writing or keeping an ad hoc guard or recognizer, inspect the
>   relevant exports of the validator or parser module already in use nearby.
>   Reuse the canonical guard for the same field; importing or delegating to
>   only one sibling capability is not evidence that an adjacent check may be
>   reimplemented more weakly.
> - Before relying on an otherwise canonical registry, read its scope note and
>   known gaps. A source documented as incomplete for this field is evidence of
>   a bounded subset, not a complete validator.
> - When no in-repo canonical source exists, record the external source,
>   verification instant, intended scope, and residual risk beside the list.
>   A finite allow-list obtained from `--help` is sometimes the least-bad
>   choice; presenting it as exhaustive without that boundary is not.
>
> **An irregular or open input language needs a declared completeness boundary,
> not another recognizer clause.** If a check interprets workflow expressions,
> Markdown, shell, AST nodes, process arguments, or another grammar, first
> choose the authority: use a real parser where it is deliverable, or pin the
> exact bounded artifact where parsing is not. State the modeled grammar/node
> set and make everything outside it a loud refusal or an explicitly unknown
> result. Never turn an unmodeled residual into a guessed concrete value merely
> because no counterexample has appeared yet. If two accepted inputs become
> indistinguishable after a lossy read, stop refining the recognizer and change
> the data source or defer the claim; no textual condition can recover erased
> information. For scanning gates, use a parser or pin the exact bounded artifact and
> account for every discovered member.

> **Prove the claim at the required precision — category evidence is not causal
> identity.** A check that says a documented event, branch, or failure happened
> must inspect the most specific signal the mechanism actually produces, not
> merely a shared error class, status family, or plausible-looking field. Map
> prose about a function's behavior to every relevant return, throw, and
> early-return site before writing the claim; a branch not enumerated is not
> evidence for either a positive or a negative statement. Similarly, validate
> every producer-owned field the function will consume before branch-specific
> handling starts. For a negative claim, local input proves only presence or
> confirmed absence; malformed, unreadable, ambiguous, or unmodeled input is
> inconclusive and must stay so. Sweep labels, comments, documentation, and PR
> text when a fix changes what a value *means*, not only when it changes a
> literal string.

> **Make adversarial tests and safe budgets structural, not just less obvious.**
> When replacing synthetic fixture data with "realistic" data, enumerate every
> distinguishability axis a decoy could observe — value, format, size, position,
> multiplicity, ordering, and ownership/enumerability where relevant — and say
> which axes remain bounded. One randomized value does not make a fixed shape or
> a tiny bounded window representative. Read reflective APIs and language
> semantics for the actual closed surface (for example, own keys and property
> descriptors), take one stable snapshot when reads can be stateful, and
> mutation-test the fixture against the live corpus. Where an imperative worst
> case cannot be mechanically derived and overestimation is safe, choose and
> document deliberate headroom instead of defending a fragile exact hand-count.
>
> These are authoring-time countermeasures for `narrow-fix-per-round`, not a
> request to invent a general framework. State the real source of truth,
> completeness boundary, invariant, and residual explicitly before accepting a
> reviewer-supplied counterexample; then search sibling call sites and branches
> using that invariant rather than adding the newest special case.

> **Check the fix's own blast radius.** Regressions introduced by a previous
> round's own fix are the next-largest round driver after unswept siblings.
> Before replying `accepted`:
>
> - Re-read the fixed hunk as fresh code: identifiers resolve, it follows the
>   PR's own conventions, and no absolute claim it adds is contradicted by
>   content in the same commit.
> - **Re-ask the invariant at its new location.** A fix that moves a boundary
>   is checked at the boundary it created: what did the move newly exclude,
>   and does any gate now derive its trigger from the thing it validates?
> - If the finding anchors to code the previous round's commit touched
>   (`git show --stat` the last pushed commit), say so in the reply —
>   regression or adjacent hole — and generalize the fix instead of patching
>   the newest variant.
> - **Follow the fixed code's own pointers.** If the changed function or
>   module's docstring names a sibling or counterpart file, grep that file
>   for the same defect class before closing the round.
> - **Mutation-test every new guard twice: a revert and a near miss.** Revert
>   the guard and watch its test go red — then also feed it one near-miss
>   input (a wrong-but-similar value, a boundary off by one, a sibling input
>   class) and watch that go red too. A revert-only mutation is insufficient:
>   it proves the guard's *behaviour*, never its *scope*. For example, a
>   `*delivered)` pattern accepts `who-knows-delivered`, while a test using
>   only `who knows` misses that near-match; a missing-path fixture does not
>   prove handling of an existing unreadable file.
> - **Check the reply's behaviour claims against the staged diff.** Each
>   behaviour the reply asserts ("cleared", "expires", "retries") must be in
>   the change being pushed, not in the code as it stood before. Test a
>   temporal claim *after* the boundary it names: an assertion read right after
>   the call cannot fail on a timer left armed.
> - Write replacement factual claims ("X is stored in Y", "Z rejects this")
>   from the source you just read, never inferred from surrounding patterns —
>   and when claiming something is enforced, name the enforcing mechanism.
> - **A completeness claim states its enumeration in the same sentence.** A
>   reply, doc or PR body asserting "every/each/all X", "fully paginated" or
>   "exactly one" says how X was enumerated — the grep, query or file list —
>   right there. If the method cannot support the claim, narrow the claim.
> - **If the fix text contains a runnable command, run it** — literally, as
>   written — before replying, or state in the reply that it was not run and
>   why. Verifying the underlying *claim* does not verify the *artifact*: a
>   `jq`/`grep` selector must be run against the real response/output shape,
>   not against field names read off a type definition.
> - **A comparison asserts both operands.** "Unlike X, Y…" makes a new claim
>   about X, and "X is deliberately excluded" is a factual claim about intent
>   — verify each with the same rigour as the correction itself, or write the
>   gap as unexplained. An invented rationale for the other side actively
>   conceals real defects.

> **Two rounds on one root cause → stop patching variants.** If this round's
> accepted fix targets the same root cause as the previous round's — another
> untrusted-input vector, another nesting depth for a text scanner, another
> heuristic for a provenance question — patching variants one by one does
> not converge: each round finds the next variant, and the structural fix is
> still needed at the end. Propose the structural fix now — read-once capture at
> the boundary, a real parser, a schema-level provenance column — or defer it
> with an issue per the [deferral protocol](references/deferral-protocol.md).
> Do not post a third variant patch.

**`**rejected**`** — the finding is wrong, already handled, or intended. Reply
with the *concrete* reason: cite the code, ADR, or test that makes it a
non-issue. Do not edit. For recurring asks that contradict a deliberate
project stance declared in the consumer's policy,
use the standing rejections in the [triage rubric](references/triage-rubric.md).

**`**wont-fix**`** — the finding is **valid but deliberately declined**: per
the [triage rubric](references/triage-rubric.md) the change's cost or churn
outweighs its value here, and the work is not obligatory, so no follow-up
issue is filed. Reply citing the rubric row that decided it. Do not edit.

`wont-fix` is neither a polite `rejected` nor a lazy `deferred`: rejected says
the reviewer was wrong; deferred says the work must happen later (tracked
issue); wont-fix says the reviewer was right and the change is deliberately
not being made. It scores as a true positive carrying a materiality signal.

**`**deferred**`** — real **and obligatory** — the work must eventually happen
— but out of scope for this PR. Clear-cut cases are decided by the
[triage rubric](references/triage-rubric.md) or the Review Arbiter; a human
decides only on arbiter escalation. File the issue — by default an entry in
the per-PR+Type **batch** issue via `scripts/defer-batch.ts`; an individual
issue (using the consumer's issue-creation workflow) only when the round report justifies one —
then reply with its link, then resolve. Follow
[deferral-protocol.md](references/deferral-protocol.md) exactly — it specifies
the `pr-followup` label, the epic-parenting rule, and the batch-by-default
contract (it, not this line, owns the batch key — restating it here is how the
two drift).

**`**moot**`** — the finding no longer applies. The code it anchors to was
removed or rewritten by a later commit, another fix resolved it incidentally, or
a subsequent round superseded it. Reply saying *what* made it moot. Do not edit.
If what made it moot is an `accepted` fix from **this same round** that has not
been pushed yet, its premise is only as solid as that fix — hold it with the
accepted batch (below) rather than resolving it here.

`moot` is not a polite `rejected`. Rejected says the reviewer was **wrong**;
moot says they may well have been **right about code that no longer exists**.
Collapsing the two poisons the reviewer's own quality signal — a correct finding
filed under `rejected` reads as a false positive it should learn from.

An `isOutdated` thread is the common `moot` case, but not automatically one: the
line moved, which does not always mean the concern died. Check whether the
substance still holds before choosing between `moot` and the other three.

#### Verify schema-governed values before applying them

A bot `suggestion` block that edits a **schema-governed field** must be checked
against its schema *before* you commit. Do not trust a reviewer's confident
value. Schema-governed fields include documentation frontmatter keys backed by a
schema, database enum columns, and any value constrained by a validation
library or parsed by a config loader.

Check the proposed value against the enum, or run the relevant pre-commit hook
on the edited file. If it is illegal, **reject the suggestion citing the
schema** rather than applying it and eating a push-then-revert cycle.

Two fields sharing a word are not the same controlled vocabulary — a document's
frontmatter `status:` and an ADR body's `**Status**:` line are different
enumerations, and a reviewer conflating them is a reject, not an edit.

#### Reply format

Every reply **starts with the outcome, in bold, as the first token of the first
line**, followed by the reason:

```text
**accepted** — added an explicit empty-body check; not yet pushed.
**rejected** — the sentinel is a fixed date; the documented clock rule governs current-time reads.
**wont-fix** — valid, but a test-only gap needing an involved harness change; declined per the triage rubric (tests tier).
**deferred** — real but out of scope; filed the linked follow-up issue.
**moot** — the branch this anchors to was removed by this round's unpushed fix; the guard no longer exists.
```

This is a **machine-read contract, not a style preference.** Replies are
harvested to score the reviewer: an accepted finding is a hit, a rejected one is
a candidate false positive, a wont-fix one is a true positive declined on
materiality, and those ratios drive reviewer tuning. A reply whose
outcome has to be inferred from prose is either dropped from the sample or
misclassified — and a misclassified reply actively teaches the reviewer the
wrong lesson.

Rules:

- Exactly one outcome token per reply, and it is the first thing in the body.
  Nothing precedes it — no greeting, no "Thanks for catching this".
- Use the values verbatim and lowercase: `accepted`, `rejected`, `wont-fix`,
  `deferred`, `moot`. Not "accept", "fixed", "wontfix" (the token is
  hyphenated), "ignored", "n/a", "obsolete".
- Follow it with a concrete reason. `reply-to-thread.ts` only requires
  whitespace then at least one American Standard Code for Information Interchange
([ASCII](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) letter or digit — an em dash (`—`) is the
  house style, not an enforced separator. The token alone is not a reply, and
  a thread still may not be resolved on a bare token.
- If a thread's outcome changes across rounds, post a **new** reply with the new
  token rather than editing the old one — the sequence is the audit trail.

`reply-to-thread.ts` **enforces this** — it refuses a body that does not open
with one of the outcome tokens, before the reply reaches the API. A convention that
is only documented drifts the moment someone is in a hurry, and a drifted reply
is a corrupted training sample rather than a cosmetic slip.

For a reply that genuinely is not an outcome — asking the reviewer a clarifying
question mid-thread — pass `--no-outcome`. It must be explicit, so an absent
token is always a decision and never an oversight.

#### Posting the reply

Reply in-thread, keyed off the thread node id, so the rationale stays attached
to the finding instead of becoming a detached top-level comment.

**Copy the `threadId` from this round's `list-unresolved-threads.ts` output,
immediately before the call — never from memory or an earlier round's list.**
Bots re-raise the same substance under new thread ids, and ids differing only
in their last characters have had replies transposed between threads when
batch-drafted from recall — a misrouted reply corrupts the reviewer-scoring
sample twice over. Work one thread fully to completion at a time.

When staging reply bodies as files, **never name the files after thread ids**:
on a case-insensitive filesystem (macOS default) ids differing only in letter
case collapse into one file and the wrong rationale gets posted. Use ordinal
names plus one mapping file.

**The body always arrives via stdin, never as a shell argument.** A backtick,
`$(...)`, or `$VAR` in reviewer-authored text gets shell-evaluated and silently
corrupts or drops words before the API ever sees them. Use a **quoted heredoc**:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/reply-to-thread.ts" "$THREAD_ID" <<'REPLY_EOF'
**accepted** — added an explicit empty-body check; not yet pushed.
REPLY_EOF
```

A pre-composed `REPLY="..."` variable does **not** solve this — a double-quoted
assignment expands the same metacharacters at assignment time, moving the
corruption one step earlier. When the body must interpolate a computed value
alongside quoted reviewer text, build it with `printf '%s'`, passing the
untrusted text as its own argument so it is substituted verbatim:

```bash
REPLY=$(printf '**accepted** — not yet pushed; your example `%s` now passes.' "$FINDING")
printf '%s' "$REPLY" | bun "${CLAUDE_SKILL_DIR}/scripts/reply-to-thread.ts" "$THREAD_ID"
```

The danger is specifically the double-quoted *assignment of untrusted text*.
Once a value is safely held, `printf '%s' "$REPLY" | ...` is fine — quoted
expansion does not re-evaluate contents.

**One refusal you may meet that is not about the body.** If
a sibling `drive-pr` skill is present (the repository's own or the plugin's), `reply-to-thread.ts` checks that
tree's drive lease immediately before posting and **exits 11** when another
live agent session in the same working tree holds it. Two sessions in one tree
put two outcome replies on every thread, which cannot be repaired once posted
 — so the refusal comes *before* the mutation rather than after it.
It names the holder's pid, a command to check whether that process is still
alive, and `drive-state.ts clear-lease <PR>`; the right response is almost
always to **stop**, not to clear the lease. With no `/drive-pr`
installed, no lease file, or a lease whose owner is gone, the reply posts
normally — absence of a lease is never itself a refusal.

Absence does have to be *established*, though. Anything the check cannot read
refuses (exit 1) rather than passing as an all-clear: a lease file it can see
but cannot parse or open, a `git` probe that failed for any reason other than
reporting "not a repository", or a `/drive-pr` that is installed with its fence
script missing. A half-installed sibling skill is a broken integration, not a
licence to post unfenced.

#### Resolving — but not for `accepted` yet

A thread may be resolved only once its outcome is **final**, and only one
outcome can still be invalidated by something downstream:

| Outcome | Reply | Resolve |
|---------|-------|---------|
| `rejected`, `wont-fix`, `deferred` | now | **now** — no code changed, so nothing can invalidate it |
| `moot` — superseded by an already-pushed commit | now | **now** — nothing left downstream can invalidate it |
| `moot` — superseded by an `accepted` fix from this same, unpushed round | now | **not here** — step 5, alongside that fix |
| `accepted` | now | **not here** — step 5, after the gates pass |

```bash
# rejected / wont-fix / deferred / moot-already-pushed only, at this point:
bun "${CLAUDE_SKILL_DIR}/scripts/resolve-thread.ts" "$THREAD_ID"
```

An accepted fix that fails formatting, types, tests, or build is not a fix yet.
Resolving its thread here closes the one place the finding was tracked, and a
converged-looking PR can then carry broken code. The same risk applies to a
`moot` thread whose only reason is an unpushed sibling fix in this round: if
that fix's gates fail, the moot thread's premise fails with it. So keep a list
of the accepted thread ids *and* any such moot thread ids, and carry both to
step 5.

If a thread was resolved prematurely — before its reply posted, or before its
fix's push landed — reverse it with
`bun "${CLAUDE_SKILL_DIR}/scripts/unresolve-thread.ts" "$THREAD_ID"` and let the normal order finish,
rather than leaving the audit trail out of sequence.

### 4. Verify and push

**The change note — only where the repository has opted in.** If
`bun "${CLAUDE_SKILL_DIR}/../changelog/scripts/check.ts" --base origin/<base>`
(the pull request's base; it reads the configuration the base holds, not the
branch's own) prints anything
but `not configured` and the pull request carries a change note, an accepted
fix that changes what the note says (an entry, or the `release:` it asks for)
updates the note in the same commit, as
[`/jig:changelog`](../changelog/SKILL.md) § Writing a note describes. Where
it prints `not configured`, no note is ever asked for.

If any thread was addressed with a code change, run `gates.command` from
step 0. If consumer instructions define change-proportional validation,
resolve the complete diff again and run **every** emitted local and verification
check before committing. A fix can pass types, lint and tests yet fail formatting
or build. Missing gate configuration is a reason to stop before committing or
resolving the held batch; do not guess a command.

Then commit with a conventional message referencing the PR. Push liveness
belongs to the caller that performs the push. When `/drive-pr` is installed,
use its `guarded-push.ts` procedure, which rechecks liveness immediately before
pushing; do not replace it with a bare push. A standalone pass must freshly
read `gh pr view "$PR" --json state -q .state` immediately before its push and
proceed only for `OPEN`. A failed read or any other state stops the pass, with
no follow-up push. An earlier round check or successful thread write is not
push authorization. The state read and Git push are also separate operations,
so this check cannot prevent a merge in that final interval. A green push
re-triggers the review bots, which may post a new round — that is the loop's cue.

### 5. Resolve the accepted batch

**Only now** — after the gates passed *and* the push landed — resolve the
accepted threads you held back, along with any `moot` thread whose premise
depended on one of those fixes. Order matters twice over: a failing commit
hook, a rejected push, or a lost worktree can otherwise close a thread whose
fix never reached the PR.

```text
gates green → commit → push → resolve held batch
```

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/resolve-thread.ts" "$THREAD_ID"
```

If the gates failed, leave every one of them **open**. That is an accurate
description of the state — the fix is not verified — and continuous mode picks
them up next round after you correct it.

### 6. Report

Summarise the round by outcome, using the same words the replies use:
N `accepted` (with the fix), M `rejected` (with the reason), W `wont-fix` (with
the one-line rubric reason — this is the human's cheap spot-check on the
loop's discretion), K `deferred` (with issue links), J `moot` (with what
superseded them). Keeping the report in the same vocabulary as the replies
means the round total is checkable against the threads.

If gates failed, say so with the output, and do **not** resolve threads whose
fix did not pass.

## Continuous mode

Review is iterative: each push produces a new round. Converging means repeating
a pass until a round finds nothing left.

**Do not build a bespoke poller, and do not blind-poll on a wall clock.** The
convergence signal is a known-latency CI job that sits pending for minutes after
every push. A fixed interval wakes straight into that gap and burns a whole
turn discovering nothing; on a slow reviewer, many of a convergence's passes
can be exactly this no-op.

`scripts/await-round.ts` owns the wait/stop decision and exits with the loop
contract:

| Exit | Meaning |
|------|---------|
| `0` | a round is ready — reviewers settled, unresolved threads exist |
| `3` | converged — reviewers settled, zero unresolved threads, no summary-only finding outstanding |
| `4` | timed out waiting for checks to settle |
| `5` | the PR is no longer open — abandon the loop |
| `7` | a reviewer check did not pass, so it may never have reported |
| `8` | zero unresolved threads, but the reviewer has summary-only findings no one has answered — they never became threads |
| `1` | the check state could not be read — never reported as settled |
| `2` | usage or configuration error (bad interval, invalid or undeclared reviewer coverage) |

Only `3` means converged. Every other non-zero is a reason to stop and look,
not a variant of "done".

Each distinction it encodes guards against a way a loop can stop wrongly or
wait forever:

- **Explicit reviewer selection requires declared coverage.** Configure
  `review.required_checks` in the consumer configuration with exact required check
  names before using `review.job_pattern` or `--job-pattern`. Each required
  check must complete; missing members keep waiting and skipped members fail.
  Leave intentionally retired optional arms out of the required list. Patterns
  select checks to wait on, and do not define membership through alternation.
  See [the configuration contract](README.md#consumer-configuration).
- **Zero threads while a reviewer job is pending is not convergence** — that
  round's comments simply have not posted yet. Exiting there abandons live
  findings on the PR.
- **A PR that merges mid-loop orphans everything after it.** Subsequent fixes
  get pushed to a branch nothing will merge, and the work vanishes with no
  error. `await-round.ts` re-checks liveness every round and exits `5`.
  Thread helpers also check immediately before each mutation, and the pushing
  caller checks before its push. Stop the active pass on any refusal;
  `converge.ts` reports a failed pass as exit `1` and starts no further round.
- **Zero threads is not zero findings.** A finding the reviewer cannot anchor
  to a diff line is posted in its summary comment and never becomes a thread,
  so a thread count cannot see it. Before reporting `3`,
  `await-round.ts` asks `/drive-pr`'s `summary-findings.ts` — the canonical
  parser of the reviewer's summary, which also tracks which findings were
  answered — and exits `8` when any is unaddressed. It is spawned
  only when a `drive-pr` skill is found (the repository's own, else the one
  beside this skill in the plugin); without one the check is skipped and says
  so, a documented residual of that setup.
  This workflow's thread-driven pass cannot answer those findings, so stop and
  read the summary: answer them with `/drive-pr`'s `answer-summary-finding.ts`,
  fix and push, or hand them to a human.

### Running the loop

Both harnesses use the same stop condition; only the pass invocation differs.

**Claude Code** — wrap a single pass in `/loop` with **no interval**, so the
model self-paces on the reviewer's completion rather than a wall clock:

```
/loop /jig:resolve-review-comments --bots-only
```

The pass itself runs step 2 of this workflow, which calls `await-round.ts` — so
the stop condition and the round counter apply to this path too. `/loop` only
supplies the pacing; it is not a second implementation of convergence.

**Codex** — for a process-driven loop, use `converge.ts`, which
runs `await-round.ts` between passes. The pass command is plain **argv after
`--`**, executed directly — never through a shell (which is also what lets it
run on Windows):

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/converge.ts" --bots-only -- codex exec "Use the jig:resolve-review-comments skill with --bots-only"
```

`converge.ts` works for any harness — Claude Code users who want the loop
outside an interactive session can put `claude -p "/jig:resolve-review-comments
--bots-only"` after the `--` instead. It bounds itself with `--max-rounds`
(default 10) so a finding the agent cannot fix cannot loop forever. When you
name a PR explicitly, the pass command must name the same PR (checked as a
delimited token) so the pass cannot silently act on the current branch's PR
while the loop waits on another.

### Polling cost

Every `gh pr view`, `gh pr checks` and `gh repo view` is a GraphQL call, and one
token's hourly GraphQL bucket backs every driver, worktree and agent on the
machine — a handful of parallel drives exhaust it. `await-round.ts` therefore
spends as little of it as it can while keeping `gh pr checks` the only source of
the checks verdict:

- **State and head commit identifier ([SHA](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md))** are read over conditional REST (`shared/gh-conditional.ts`).
  An unchanged PR answers `304 Not Modified`, which does not count against the
  primary rate limit. The PR argument must be a number: a URL or branch name is
  refused up front with exit 2, as `list-unresolved-threads.ts` would refuse it
  later.
- **`gh pr checks`** is skipped for a tick only when the previous read *in this
  process* was a keep-waiting one (`pending` or `no-reviewer`), is younger than
  `AWAIT_ROUND_CHECKS_MAX_AGE` seconds (default 300; `0` always reads), was for
  the same head commit, and GitHub confirms neither the PR's check runs nor its
  commit statuses changed. A terminal or unreadable verdict is never reused, so
  reuse cannot manufacture a convergence. The age limit bounds only how old a
  reused verdict may be when a tick decides to reuse it; it is not a deadline on
  when a transition is noticed, since each tick's own `gh` calls and the polling
  sleep add to it. `--once` never skips.
- **`gh repo view`** answers from a small cross-process cache, keyed by the
  checkout's remotes, `gh repo set-default` and `$GH_REPO`, so a change of any
  of them is a miss.

The persisted part of that cache (PR-body ETags and `gh repo view` results)
lives in `$JIG_GH_CACHE_DIR` (default `~/.cache/jig/gh-cache`), one bounded,
overwritten file per request; check-signal ETags are process-local and never
written to disk. `JIG_GH_CACHE=off` disables the on-disk cache. Under `NODE_ENV=test` it is off unless a
directory is given, so a suite that forgets to isolate itself runs uncached
rather than reading another test's answer.

Diagnosing a spent bucket: read the `X-RateLimit-*` **response headers** of a
real call (`gh api -i graphql -f query='{viewer{login}}'`). Do not use
`gh api rate_limit` — it reported a fresh bucket while the enforced headers
showed one nearly exhausted.

### A long review is a scaffolding signal

When a PR takes **more than three rounds** to converge and reflection is on (a
`reflection` section in some configuration layer), `await-round.ts` says so
at **wind-down** — the moment it reports convergence, not during the loop —
notes the round count in the reflection journal, and asks for a
[reflection](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) with
[`/jig:reflect`](../reflect/SKILL.md). With reflection off it asks for nothing.
Tune the boundary with `REFLECT_THRESHOLD` (default `3`). Separately, every round
counted past that boundary prints a reminder of
"Two rounds on one root cause" in step 3.

Placement decisions that matter:

- **It lives in `await-round.ts`**, the one script both harness paths call, so a
  Claude `/loop` session that never invokes `converge.ts` still gets it.
- **The count persists in the git dir**, so rounds worked across separate
  invocations — even hours apart — add up to one session total. A per-process
  counter would reset every pass and never reach the threshold.

It fires at wind-down rather than mid-loop because that is the only point where
there is something settled to reflect *on*: while rounds are still arriving the
picture is incomplete, and a prompt then competes with the work. The nudge exists
because that many rounds is rarely a noisy reviewer. It usually
means the scaffolding under-served the change: an instruction that did not land,
a rule the reviewer had to teach us more than once, a convention that should
have been mechanised, or a reviewer configuration that let a known class
through. That signal is richest at the moment of convergence and decays fast
once the session ends — which is exactly why it is emitted there rather than
left for someone to reconstruct.

When you take it up, ask where the fix belongs: an instruction file, a skill, a
rule, or the reviewer config. "The reviewer was wrong four times" is itself a
finding — it belongs in the reviewer's config or its eval corpus.

Use `--bots-only` for continuous mode in either harness. Human threads
intentionally stay open for their authors, so they are handled in a one-shot
invocation and reported — see below.

## Human threads

Resolving another person's thread is a social act:

- **Bot threads** — address, reject, or defer and resolve freely. The expected identities come from `review.bots`; `--bots-only` uses
  GitHub App authorship rather than a consumer-specific hard-coded list.
- **Human threads** — address or reply, but prefer to leave the *resolution* to
  the author unless it is an unambiguous nit you fixed. When in doubt, reply
  "**accepted** — added the missing guard; not yet pushed" and leave it open for them to close. The
  outcome token still belongs there; leaving resolution to the author does not
  exempt the reply from the harvesting contract.

This is the one deliberate exception to "every acted-on thread ends resolved",
and it is why continuous mode targets bot threads.

## Guardrails

- **Never resolve without a fix or a reply.** A resolved thread with no trace
  reads as silently dismissed.
- **Never `REQUEST_CHANGES` or `APPROVE`.** This procedure replies and resolves;
  it does not gate merges.
- **Never mark a PR ready for review.** A human does that, or `/drive-pr` at
  the round the repository's `pull_requests.mark_ready` declares.
- **Gates are mandatory** for any code you changed. A fix that breaks the build
  is worse than an open thread.
- **`--dry-run` writes nothing.**
- Keep replies short and specific; link the commit, ADR, or test that backs the
  decision.

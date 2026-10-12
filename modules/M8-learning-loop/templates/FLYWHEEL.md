# The learning loop (miss→lens flywheel)

> TEMPLATE — copy to your repo (e.g. `docs/development/miss-to-lens-flywheel.md`)
> and adjust the tool names. This is the named process doc for turning a miss
> into a permanent improvement. Invariant it encodes: **every significant miss
> is classified, filed with a durable id, reconstructed as a pre-fix eval
> fixture, answered with an additive lens, validated before it can gate, and
> then measured.** It generalizes to any evaluable agent behavior — review is
> just the first instance.

## Why a loop, not a post-mortem

A miss noticed and discussed changes nothing; a miss turned into a check changes
everything downstream. The flywheel's whole job is to make "we won't miss this
again" *mechanical* instead of aspirational. Each turn of the wheel makes the
next miss of the same class impossible to repeat silently.

## The flywheel

```
oracle catches a miss
   → classify (miss taxonomy)
   → file with a durable lever id (L-NNNN)
   → reconstruct as a PRE-FIX eval fixture (required: false)
   → add an additive lens that would have caught it
   → validate live (fixture now caught) → flip to required: true
   → measure recall / precision / cost → keep, promote, or kill the lens
```

### 1. Classify

Bucket the miss against the [miss taxonomy](https://github.com/docomply/jig/blob/main/modules/M8-learning-loop/templates/miss-taxonomy.yaml) — a closed
vocabulary. A fixed vocabulary is what makes patterns countable: "a third of our
misses are error-path bugs" is only visible if every miss carries a category.

### 2. File with a durable identifier

Record the miss with a stable **lever** number in your tracker. The number is
permanent — a lens, a fixture, and a metric will all reference it. Lever numbers
must be **unique**; assigning "the next number" from parallel branches collides
exactly as ADR numbers do, so guard it the same way.

### 3. Reconstruct as a pre-fix fixture

Add a [corpus](https://github.com/docomply/jig/blob/main/modules/M8-learning-loop/templates/corpus.yaml) entry that pins the commit **before** the fix and
records the finding the reviewer *should* have produced. Pre-fix is the whole
point: a fixture pinned after the fix passes trivially and proves nothing. Mark
it `required: false` — it is not yet a gate.

### 4. Answer with an additive lens

Add **one** numbered lens (a prompt module, checklist bullet, or gate) that
would have caught this miss, and link it to the lever. **Additive** is a
discipline: the lens list only ever grows. A change that would rewrite or drop
an existing lens is suspect — you would be trading away coverage you earned from
a past miss.

### 5. Validate, then gate

Run the reviewer against the new fixture. Only when it demonstrably catches the
miss does the fixture flip to `required: true` and join the **regression
corpus** — the set that must keep passing forever. Record the validation (who,
when, the run). An unvalidated fixture sitting in the blocking gate is the thing
this step exists to prevent.

### 6. Measure

Track the lens's recall, precision, and cost *marginally* against your oracles —
the [parity report](https://github.com/docomply/jig/tree/main/modules/M8-learning-loop/reference/parity-report). Two numbers drive decisions:

| Signal | Decision it drives |
|--------|--------------------|
| `missed_blockers` (oracle caught a blocker the reviewer didn't) | a reopened lever; possibly a vendor you can't yet drop |
| precision (share of a lens's findings that are real) | promote the lens to blocking (clears [M7](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review)'s bar), keep it advisory, or kill it |

A lens that fires mostly false positives is *removed* — a noisy lens costs more
attention than it saves. Killing a lens is a normal outcome, not a failure.

## Companion cycle: session reflection

The same shape, applied to process feedback:

1. A `/reflect`-style step at session end appends feedback to an **inbox** (raw,
   unprocessed).
2. A separate step processes the inbox into **proposed** scaffolding changes.
3. **A human approves** before any rule/spec/gate is edited — changing the rules
   the agents follow is self-modifying and stays [HITL](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md).

## Companion cycle: memory promotion

1. An agent keeps **private, per-session memory** while it works.
2. A `/promote-memory`-style step lifts durable lessons into **git-tracked,
   shared** memory, so a lesson survives the session and reaches other agents.
3. Promotion is a **review point**, not an automatic dump — a wrong "lesson"
   promoted becomes everyone's wrong lesson.

With Jig's plugin, this step is
[`/jig:promote-memory`](https://github.com/docomply/jig/blob/main/plugin/skills/promote-memory/SKILL.md).

## Anti-patterns this loop forbids

- **Fixing without filing.** A miss fixed but not recorded as a lever + fixture
  will recur; the fix protected one PR, not the class.
- **Post-fix fixtures.** Pinning the commit after the fix makes a green fixture
  that never tested anything.
- **Gate-before-validate.** Promoting a fixture to `required: true` before a
  live run makes the regression corpus lie about what it proves.
- **Rewriting lenses.** Editing away an existing lens to "clean up" trades
  earned coverage for tidiness.
- **Advisory forever.** A lens that never gets measured never gets promoted or
  killed — it just accretes as noise.

# Structured answers, approving or choosing a parked decision in a word: design

**What problem this solves.** When an unattended drive
[parks](../GLOSSARY.md) a decision for a person, it frames it: the question,
each option with what it changes and what it costs, and the option it
recommends. Most of the time the person's answer is "yes, the recommended
one", or the name of another option. Today they still write it in their own
words, and the next pass reads those words and works out which option they
meant. "ok" answers nothing clearly, "go with the second" depends on an
order the person may have read differently, and an answer that names an
option the park never offered is handed on as if it were one. Nothing
records which option was chosen, so no reader can show it, and nobody can
tell how often a kind of decision simply follows the recommendation. With
this built, a person approves the recommended option with one word, or
names another option, from a terminal, the dashboard, the Orca panel or a
phone. The line reads the option itself, ties the answer to the framing
it answers when the answer names it, and hands the pass the option rather
than words to interpret. An answer in the person's own words still works
as it does today.

This is the design of [plan.md](plan.md) item 46. It builds on what is
already there: the framed park and its decision record
([ADR-0010](../docs/adr/ADR-0010-parking-is-reserved-for-registry-classes.md),
`skills/drive-pr/scripts/lib/state/framed-park.ts`), the answer `jig send`
writes (the `drive-answer` record, [plugin/RECORDS.md](../plugin/RECORDS.md)),
the [re-arm](../GLOSSARY.md) that reads answers
(`skills/drive-pr/scripts/lib/driver/rearm.ts`), and the
[act](../GLOSSARY.md) every need opens with
([line-at-capacity.md § What each need asks of a person](line-at-capacity.md#what-each-need-asks-of-a-person)).

## The rule

A person's answer to a framed decision is either a **structured answer**,
whose whole text names exactly one of the decision's options, or a **free
answer** in the person's own words. The line hands a structured answer's
option to the pass as the decision record states it; a pass interprets a
free answer, as it does today. Text that is not exactly a structured form
is a free answer, so an answer is never lost for its wording. A structured
answer adds no authority: who may answer is decided in one place
(`shared/trusted-authors.ts`) for both forms. An answer that names the
framing it answers counts only while that framing stands.

## How it works

### Today

A drive parks an item with `drive-state.ts park --class <class>` and a
decision record on stdin, whose sections the script checks: Question,
Options (two or more, each a `**name**` with `Changes:` and `Costs:`),
Recommended (one option by its `**name**`, and why), Class, Steps for a
person, Already done. The park stores the record and the time. The drive
ledger on the pull request publishes the record with email addresses and
account ids redacted (`state/ledger.ts`).

An item counts as answered once a comment from a trusted author, later than
the park, is either any reply on the item's review thread or a pull-request
comment with a line `answer <key>: <text>` outside any code block. `jig send
drive@<repo>#<PR> answer <key> '<text>'` writes the second kind, with a
[record envelope](../GLOSSARY.md) naming the writer and its host in a hidden
marker, and refuses to send a second answer to an item already answered.
Once every parked item is answered, the re-arm unparks them all and hands
each answer's whole body to every pass as a human verdict
(`$DRIVE_PR_PASS_NOTICE`, kept in `drive-pr-<PR>.answers.json` until a pass
completes). The [tick](../GLOSSARY.md) reads the same answers to decide
whether a parked drive can be re-armed, and `jig ask` reads them to show
whether a question is answered.

### The forms

An answer's text is read from a comment by a trusted author, later than the
park:

- In a pull-request comment, each line `answer <key>: <text>` outside a code
  block gives `<text>` as an answer to `<key>`.
- In a reply on the item's review thread, the reply's text is the answer;
  a reply whose only line is `answer <key>: <text>` for that item gives
  `<text>`.

Before matching, the reader removes `jig send`'s answer record, blank
lines and quoted lines (lines opening with `>`, which repeat someone
else's words). The text is a structured answer only when nothing else is
left in the comment: in a pull-request comment, every remaining line is an
`answer <key>:` line, at most one for each key; in a thread reply, the one
remaining line is the answer. Any other line in the comment makes each
answer in it a free answer, so a condition written on the next line ("but
only after the migration merges") always reaches the pass as the person's
words.

A text is then a structured answer when, after normalizing, it is exactly
one of these forms:

| Form | Chooses |
| --- | --- |
| `approve` | the option the record recommends |
| `choose <option>` | the option whose normalized name is `<option>` |

Either form may end with the framing's decision digest in square brackets,
`approve [3fa9c2d1e0b4]` (see [Binding an answer to its
framing](#binding-an-answer-to-its-framing)).

Normalizing applies Unicode compatibility normalization (NFKC), folds case,
turns typographic quotes and dashes into their plain forms (a phone types
`Don’t release` for `Don't release`), removes backticks and the record's
bold marks, and reads every run of white space as one space. Option names
are normalized the same way, and a park whose option names are the same
once normalized is refused when it is parked, so no `choose` can name two
options.

Everything else is a free answer: `approve, but keep the old flag`,
`choose Keep, but rename it`, `choose whichever is cheaper`, a `choose`
that names no option of the decision, and `approve` on a park whose record
names no recommended option (one parked before parks were framed). The pass
reads a free answer as it does today, and `jig ask` and the dashboard
label it free, so a person who meant a structured answer sees it was not
read as one.

There is no `decline` form. Every framed decision offers at least two
options, and refusing what one option allows is choosing another. A
decision record for a class whose act is Authorize names the refusal as an
option of its own (**Keep it off**, **Do not release**), so `choose` covers
it. The writing rules for a decision record
([human-call elaboration](../plugin/skills/decide/references/human-call-elaboration.md))
and the HITL registry template gain that sentence.

### Several answers to one item

An item can collect answers from more than one comment. Each person's
answer is their latest one, structured or free, so a person who changes
their mind before the re-arm reads it simply answers again, and a later
"wait, don't" replaces their earlier `approve`. Across people:

- When every person's latest answer is structured and all choose the same
  option, that option is chosen.
- When any person's latest answer is free, the item is answered with every
  person's latest answer handed on, the free ones as text and the structured
  ones as the options they chose, and the pass interprets them, as today.
- When the structured answers of two people choose different options, the
  item is not answered. It waits, and the notification names both answers:
  a disagreement between two people is theirs to settle.

An item with any trusted answer, a disputed one included, is never decided
provisionally at the `wide` [autonomy level](../GLOSSARY.md): a provisional
decision takes only an item nobody has answered.

Who may answer is unchanged: any trusted author, whoever the park names as
the person it waits on.

### Binding an answer to its framing

An answer counts only when it is later than its park, and parking an item
again resets that time, so an answer written before a decision was framed
again never settles the new framing. One race remains: a person reads a
notification, the drive frames the decision again, and the person answers
the old framing after the new park. A drive frames a parked item again only
when it is re-armed with the item still unanswered (to repair a conflict,
say) and a pass parks the same item, which is rare; but a one-word
`approve` would then approve a recommendation the person never read.

So each framed park has a **decision digest**: the first 12 hexadecimal
characters of the SHA-256 of its record as the ledger publishes it, that
is, after redaction. Redaction gives the same text a second time, so the
re-arm, reading the local record, and the tick, `jig ask` and `jig send`,
reading the ledger, compute the same digest. It is computed when read and
never stored. Every place that shows a person the options (the
notification, `jig ask`, the dashboard, the Orca panel) gives the answer
lines with the digest of the framing it read, and `jig send` writes the
digest into the line and into the answer's record. A structured answer
that names a digest counts only when the digest is the park's current one;
one naming another digest is a **stale answer**: it does not count, the
item stays waiting, and the next tick's notification says so at once (the
stale answer's comment is part of the notice's key). A structured answer
typed without a digest is bound by time alone; the notification says the
digest-bearing line is the one to copy.

### What the drive does with a structured answer

Each kept verdict (`PendingVerdict` in `state/pass-handoff.ts`) gains a
`choice`: the option's name, whether it is the recommended one, the form,
the digest of the framing it chose from, the person, the time and the
comment's link. The notice to the pass then reads, for that item:

> @person chose **Keep** (the recommended option) from framing
> 3fa9c2d1e0b4. Apply this option as the decision record states it.

followed by the decision record, so the pass has the option's Changes and
Costs in front of it. The pass records the item's outcome as it does today,
and its reply names the option and who chose it. Once the ledger keeps
resolved parks (the hub's first stage,
[hub.md § Build order](hub.md#build-order)), each keeps its choice beside
its answer.

Whether a pass applied the chosen option is not checked by a script: what
an option changes is prose. The [mechanism map](../plugin/MECHANISMS.md)
lists this as a boundary held by the pass's instructions. A structured
answer narrows it, since the pass no longer chooses, but does not close it.

### Writing an answer

Every way of answering writes the same line, so the readers have one form
to read.

- **`jig send`.** `jig send drive@<repo>#<PR> answer <key> --approve`, or
  `--choose '<option>'`, beside the existing free text. The send refuses an
  option the park does not offer before it writes, shows the option it will
  choose in full (its Changes and Costs) with `--dry-run`, and writes the
  line with the digest and, beside the envelope, the digest and the choice
  as payload fields of the `drive-answer` record. The record stays at
  version 1: a reader that does not know a payload field ignores it, while
  a newer version would make an older plugin refuse the comment as an
  answer. A person who already answered may answer again, which replaces
  their earlier answer; the send shows the earlier one first. `--all
  --approve` approves every open item of the pull request whose act is
  Decide, one comment per item, after listing each; an item whose act is
  Authorize is approved only by its own key.
- **The operator.** "approve 456's parked question" becomes that command,
  run with `--dry-run` first, as every send the operator makes is.
- **The dashboard.** A parked need's card shows the recommended option
  first, as item 44 builds it, with a copy button beside each option for
  its line, digest included. `c` copies the `approve` line of a Decide
  need; an Authorize need's line is copied only from the button beside the
  option's Changes and Costs. The page copies; it does not write
  ([#477](https://github.com/jig-harness/jig/issues/477) decides whether
  it ever will).
- **The Orca panel.** Its answer box gains **Approve** and one button per
  option, which run the same `jig send` as the person
  ([orca-integration.md](orca-integration.md#the-jig-plugin-for-orca)); an
  Authorize need's button shows the option's Changes and Costs and asks
  once more before it sends.
- **The forge, by hand.** A person types `answer <key>: approve` in a
  pull-request comment, from the forge's site or its phone app, or replies
  `approve` on the item's review thread. On a forge that turns an email
  reply into a comment by the person who sent it, replying to the
  notification email works the same way. This path needs no Jig code, and
  carries the digest only when the person copies it.
- **The notification.** The message the tick writes for a parked drive
  lists, for each item, the lines that answer it, digest included:
  `answer <key>: approve [<digest>]` and one `choose` line per other
  option.
- **Other review tools.** A tool that collects a person's verdict (a local
  review interface's "finish" hook, say) answers by running `jig send`. It
  never writes the comment itself and never holds the answer.

### Reading answers

The comment on the pull request stays the one record of an answer
([ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)). The re-arm and
the tick already read it, and `jig send` already wakes the repository's
tick, so an answer sent from a terminal or the panel is read at the tick
it wakes, and one typed on the forge within one tick's interval. Nothing
listens for the forge's webhooks.

The reader lives beside the record that writes it, in
`skills/drive-pr/scripts/lib/answer-forms.ts`. Every place that decides
whether an item is answered reads through it: the re-arm (`parkAnswers`),
the tick's ledger source, `jig send`'s check, and `jig ask`'s drive,
thread and waiting readers (`ask/lib/drive.ts`, `ask/lib/thread.ts`,
`ask/lib/park-wait.ts`). They move together, so no two of them disagree on
whether an item is answered. It takes the option names and the
recommendation from the record through the helpers `state/park-frame.ts`
exports.

### Showing what was decided

- **`jig ask --thread`.** A question entry carries its options (each name,
  and whether recommended) and its digest. An answer entry carries its
  `choice`, or `free: true`, or `stale` with the digest it named. These
  are added fields under `ask`'s version 1, as
  [addresses.md](addresses.md#what-the-thread-gains-for-the-hub) grows the
  thread.
- **The line and the dashboard.** A parked need whose answers are stale or
  disputed keeps its act and says which, with the options.
- **The [outcome log](../GLOSSARY.md).** When the tick of the host that
  owns the repository reads a parked item gone from the ledger with the
  answers it last read, it writes an event row: the class, whether the
  choice was the recommended option, the form, and how long the item
  waited. The ledger is on the pull request, so a re-arm on any host is
  counted, as far as the owner's tick ran to see it.
- **Recommendation acceptance.** `jig dispatch log` reports, per class and
  repository, how many parks were answered, how many with the recommended
  option, and the median wait. That is evidence for a person deciding
  whether a class should stay a park
  ([ADR-0010](../docs/adr/ADR-0010-parking-is-reserved-for-registry-classes.md)):
  a class approved as recommended almost every time costs a person's
  attention for little. The line never acts on it.

### Who may answer

A structured answer counts under the same rule as a free one: a trusted
author, by `shared/trusted-authors.ts`. That rule cannot yet tell a person
from a pass that posts under the person's login
([item 40](plan.md#40-the-pass-trust-boundary-as-mechanisms)), and a pass
that could post "yes, go ahead" can already settle a park today. A
structured answer adds no authority, but it makes an approval cheaper to
give, to copy and to forge, and harder to notice. So Authorize items are
left out of `--all` and of one-key copying, and the classes whose wrong
answer cannot be undone wait on proof that a person answered:

- **Attested classes.** `autonomy.attested_classes`, by default
  `destructive`, `release` and `legal`, lists the classes whose answers
  count only with such proof. It is read as `autonomy.park_classes` is:
  in a pass, from the repository's configuration at the base branch's
  commit, so a pass cannot loosen it on its own branch. The setting
  arrives with the first proof item 40 builds, never before it: a setting
  with no proof to check would either do nothing or stop those classes
  being answered at all.
- **What counts as proof** is item 40's to choose, and one choice serves
  both. The candidates for answers, and what each needs:
  - **A pass identity of its own.** Passes post under their own forge
    identity, so the person's login is the person. This settles every class
    at once and is item 40's first candidate.
  - **A signature with a hardware-held key.** `jig send` signs the answer's
    fields (the pull request, the key, the digest, the choice, the time)
    with `ssh-keygen -Y sign` under a namespace of its own, with a key held
    by a security key that needs a touch, or by the operating system's key
    store. A key in a file does not count, even with a passphrase or a
    confirming agent: a pass running as the same user can read the file.
    The reader checks the signature against signers the repository's
    configuration lists at its base branch, not against the keys the forge
    publishes for the login, since a token that can post as the person may
    also be able to add a key to their account. It works from a laptop, not
    from a phone.
  - **A button only a person can press.** On GitHub, a check run carries up
    to three action buttons, and a click reaches only the GitHub App that
    created the check run, as a webhook naming who clicked; no API call
    presses one. It needs a GitHub App and an endpoint the forge can reach,
    a listening service that [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)
    rules out today and that would need a decision of its own, and its
    webhook secret must be out of reach of every pass, so not on a host that
    runs them.
  - **A passkey on the hub**, in the hub's third stage
    ([hub.md § When the hub writes](hub.md#when-the-hub-writes)).

### Records

The `drive-answer` row in [plugin/RECORDS.md](../plugin/RECORDS.md) gains
the line's digest suffix and the payload fields `decision` (the digest)
and `choice` (the option's name and the form). Item 39's third stage adds
the plan id, the dry run's digest and the kind of proof to the same record
([addresses.md](addresses.md)); both add payload fields under version 1, so
neither waits on the other.

### Beyond the drive

The forms fit any framed question, and each of these becomes a step of its
own once the drive's answers work:

- **A follow-up's question.** A follow-up pass that stops on a question a
  person must answer frames it as a park does and takes its answer through
  `jig send followup@… answer`, rather than a free `Question:` line read
  from its output.
- **A loosened ratchet.** Item 40 counts a `Ratchet-Loosen` trailer only
  with evidence a person gave it. A drive that needs one parks under
  `rules` with the loosening as an option; a structured answer choosing
  it, recorded on the pull request, is the evidence the ratchet reads.
- **A pickup only a person may start.** An item flagged for a person reads
  "needs a person to start" (item 44). That becomes an Authorize decision
  on the item, answered in a tracker comment, which the pickup reads before
  it claims.

## Build order

One pull request per step, each shippable alone, each with a change note
and its pull request saying what changed in the audit.

1. **The forms in the drive and its readers.** `answer-forms.ts` (the
   forms, normalizing, the whole-comment rule, several answers, the digest
   and the stale answer); every reader named in [Reading
   answers](#reading-answers) moved to it at once; the park's refusal of
   option names that collide; no provisional decision over an answered
   item; the verdict's `choice` and the pass notice; the stale answer in
   the notice's key; `drive-pr`'s SKILL.md and README, the decision
   record's writing rules and the HITL registry template on an Authorize
   refusal option, and the mechanism map's entry. Waits on the record
   helpers [#674](https://github.com/jig-harness/jig/pull/674) exports.
   Done when a park answered `approve` hands the pass the recommended
   option, a `choose` naming no option reaches the pass as a free answer
   and `jig ask` labels it free, a stale answer leaves the drive parked and
   says why, and two people choosing different options leave the item
   waiting.
2. **Writing them.** `jig send … answer --approve | --choose | --all`, a
   correcting answer, the record's payload fields and its RECORDS.md row,
   the operator's verbs, and the notification's answer lines. Done when a
   send naming no option is refused before it writes, and a sent answer
   whose framing has since changed does not count.
3. **Showing them.** `jig ask`'s question and answer fields, the
   dashboard's copy buttons and stale or disputed answers, the Orca
   panel's buttons, and the outcome log's answered-park event. Done when
   the panel, `jig ask` and the dashboard show the same options and the
   same choice for one park.
4. **Recommendation acceptance.** The per-class report in `jig dispatch
   log`. Done when it reports, from the outcome log alone, each class's
   parks, approvals of the recommendation and median wait.
5. **Attested classes**, with item 40's first proof, and
   `autonomy.attested_classes` in [CONFIGURATION.md](../plugin/CONFIGURATION.md).
6. **Beyond the drive**: the follow-up's question, the loosened ratchet
   and the pickup, one pull request each.

## Left out

- **An answer for every item at once** (`answer all: approve`). Each item
  is answered by its own line, so each approval names the decision it
  approves; `jig send --all` writes those lines for a person, for Decide
  items only.
- **Words beside a structured answer.** A comment that says more than the
  form is a free answer. Carrying a note that "never changes the choice"
  would ask a pass to ignore what a person wrote.
- **Applying an option without a pass**, such as marking a pull request
  ready on an approved `ready` park. Worth measuring first: step 4 shows
  which classes are approved as recommended, and a step that skips the pass
  for one of them is a design change of its own.
- **Writing from the dashboard.** The page copies lines; #477 and item 40
  decide whether it writes.
- **Reactions as answers.** An emoji cannot name an option, is as easy for
  a pass to add as a comment, and is easy to add by accident.
- **The forge's pull-request approval as an answer.** It approves the pull
  request for merging, not a decision; reading one as the other would let
  a review approval settle a `destructive` park.
- **Approvals that expire.** A park waits until it is answered or framed
  again; the notification repeats until then.
- **Another tool as the store.** A review interface may produce answers
  through `jig send`; the record stays on the pull request, where the drive
  and every other reader already look.

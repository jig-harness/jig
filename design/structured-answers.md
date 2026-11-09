# Structured answers, approving or choosing a parked decision in a word: design

**What problem this solves.** When an unattended drive
[parks](../GLOSSARY.md) a decision for a person, it frames it: the question,
each option with what it changes and what it costs, and the option it
recommends: a [framed decision](../GLOSSARY.md). Most of the time the person's answer is "yes, the recommended
one", or the name of another option. Today they still write it in their own
words, and the next [pass](../GLOSSARY.md) reads those words and works out which option they
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

A drive parks an item under its [decision class](../GLOSSARY.md) with
`drive-state.ts park --class <class>` and a decision record on stdin, whose sections the script checks: Question,
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
lines and the quoted lines that repeat the notification (lines opening
with `>` whose text is a line of the notification the reader can
identify). Any other quoted line is a line of the comment: a person may
quote a condition of their own, and an unexplained quote makes the answers
free. The text is a structured answer only when nothing else is
left in the comment: in a pull-request comment, every remaining line is an
`answer <key>:` line, at most one for each key; in a thread reply, the one
remaining line is the answer. Anything else left is another line: a line of
prose, a fence marker and every line inside a fenced block (a suggestion
included), an indented code line, HTML. Any other line makes each answer in
the comment a free answer, so a condition written on the next line ("but
only after the migration merges") or a suggested change always reaches the
pass as the person's words. A comment that leaves no text at all is no
answer, as today. The pass receives every answer's whole comment either
way.

An answer's time is when its comment was last edited, or posted when it
never was: an answer counts only when that time is later than the park, and
a person's latest answer is the one with the latest time. The forge gives
both times (`lastEditedAt` and `updated_at`), which the readers fetch
beside the posting time they read today. The re-arm keeps, with each
answer it hands on, the hash of the body it read; an edit after that does
not change the verdict already handed on, and `jig ask` shows the answer
as edited since it was read.

A text is then a structured answer when, after normalizing, it is exactly
one of these forms:

| Form | Chooses |
| --- | --- |
| `approve` | the option the record recommends |
| `choose <option>` | the option whose normalized name is `<option>` |

Either form may end with the framing's decision digest in square brackets,
`approve [3fa9c2d1e0b4]` (see [Binding an answer to its
framing](#binding-an-answer-to-its-framing)). The reader takes a trailing
digest off the line first, before it looks up an option or classifies the
comment, and keeps the text for display; a digest that is not the park's
current one makes the answer stale whatever else the comment holds.

Normalizing applies Unicode's compatibility normalization, folds case,
turns typographic quotes and dashes into their plain forms (a phone types
`Don’t release` for `Don't release`), removes backticks and the record's
bold marks, reads every run of white space as one space, and drops one
full stop or exclamation mark at the end, which a phone's keyboard may add
(`Approve.`). Option names are normalized the same way, and a park whose option names are the same
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
and the human-in-the-loop ([HITL](../GLOSSARY.md)) registry template gain
that sentence.

### Several answers to one item

An item can collect answers from more than one comment. Each person's
answer is their latest one, structured or free, so a person who changes
their mind before the re-arm reads it simply answers again, and a later
"wait, don't" replaces their earlier `approve`. Across people:

- When every person's latest answer is structured and all choose the same
  option, that option is chosen.
- When every person's latest answer is free, the item is answered and every
  one of them is handed on for the pass to interpret, as today.
- When two people's latest answers are not the same option (two structured
  answers choosing different options, or a structured answer beside
  another person's free one), the item is **disputed**. It is not answered:
  it waits, and the notification names the answers. A disagreement between
  two people is theirs to settle, and a free answer beside an approval may
  well be one.

`parkAnswers`, which the re-arm and the tick share, returns disputed and
stale items (see the next section) beside the answered and waiting ones,
and the notice for a parked drive carries the disputing or stale comments
in its key, so a dispute or a stale answer that arises after the first
notice is sent at once rather than at the next repeat.

An item with any answer from a trusted author after its park, whether it
counts, is disputed or is stale, is never decided provisionally at the
`wide` [autonomy level](../GLOSSARY.md): a [provisional
decision](../GLOSSARY.md) takes only an item nobody has answered.

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
characters of the SHA-256 of its record, computed once, when `drive-state.ts
park` stores it, and stored on the parked item (`ParkedItem.digest`)
beside the record. The [drive ledger](../GLOSSARY.md) publishes it with the
park, so the re-arm, reading the local state, and the tick, `jig ask` and
`jig send`, reading the ledger, compare against the same stored value; none
of them hashes a record, so a change in what the ledger redacts cannot make
them disagree about the digest. Storing it settles redaction, not
freshness: after a reframe the local state can hold digest B while the
ledger still holds A, and an answer naming A is stale to the re-arm and
current to the tick. The re-arm therefore compares an answer's digest with
the ledger's too, when it can read the ledger, and an answer whose digest
matches the local state but not the ledger (or the reverse) is reported as
a lagging publication, not answered: the notice says the ledger has not yet
caught up, and the driver's next write publishes the park again. A park
from before digests has none, and its answers are bound by time alone.

Option identity gets the same care. The ledger redacts email addresses and
account identifiers in a park's record, so two options that differ only
there (`Notify alice@example.test`, `Notify bob@example.test`) would read as
one option to the tick, `jig ask` and `jig send`, and as two to the re-arm.
`drive-state.ts park` therefore refuses a record with an option name that
redaction changes (an email address or an account identifier in a name),
and one whose names are the same once normalized, so the names every
reader sees are the names the person types and copies.

Every place that shows a person the options (the notification, `jig ask`,
the dashboard, the Orca panel) gives the answer lines with the digest of the
park it read, and `jig send` writes the digest into the line and into the
answer's record. A structured answer that names a digest counts only when
it is the park's current one; one naming another digest is a **stale
answer**: it does not settle the item, which stays waiting, and the next
tick's notification says so. The digest is read before anything else on the
line (see [The forms](#the-forms)), so `choose Removed option [old-digest]`
and `approve [old-digest]` followed by `Thanks` are stale, not free, and
never settle an item under the all-free rule. A structured answer typed without a digest is
bound by time alone; the notification says the line with the digest is the
one to copy. A re-arm by a plugin older than this design reads the digest
as part of a free answer, so the binding holds once every host that
re-arms the repository's drives runs a plugin that reads it.

### What the drive does with a structured answer

Each kept answer (`PendingAnswer` in `state/pass-handoff.ts`) gains its
`choice`, when it is structured: the option's name, whether it is the
recommended one, the form and the digest it named. Each kept verdict
(`PendingVerdict`) gains the park's `record` and digest, since the park and
its record are gone once the re-arm unparks it, and the notice's length
budget (`NOTICE_MAX`) covers the records with the answers. The notice to
the pass then reads, for an item answered with one structured choice:

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
  `--choose '<option>'`, beside the existing free text. The command takes
  the digest the person read (`--decision <digest>`, which every copied
  command carries) and refuses, writing nothing, when the park it fetches
  has another: the person read framing A, and a send never approves B. A
  `--dry-run` prints that digest, and the real send must name it. The send refuses an
  option the park does not offer before it writes, shows the option it will
  choose in full (its Changes and Costs) with `--dry-run`, and writes the
  line with the digest and, beside the envelope, the digest and the choice
  as payload fields of the `drive-answer` record. The record stays at
  version 1: a reader that does not know a payload field ignores it, while
  a newer version would make an older plugin refuse the comment as an
  answer. A person who already answered may answer again, which replaces
  their earlier answer; the send shows the earlier one first. `--approve`
  is refused on a park whose record names no recommendation. `--all
  --approve` takes no single digest: its `--dry-run` lists each eligible
  item with its digest and prints one set token (the hash of the sorted
  key and digest pairs), and the real send names that token
  (`--decision-set <token>`). It re-fetches the open items, and refuses,
  writing nothing, when the eligible set or any item's digest differs from
  the listed one, so no item is approved on a framing the person did not
  see and a park added or reframed since is never swept in. `--all
  --approve` approves, one comment per item and after listing each, every
  open item of the pull request whose class the shared acts table
  (`shared/acts.ts`) lists as Decide by name; a class the table does not
  list (a repository's own class, which reads Decide only as a fallback)
  and a class whose act is Authorize are approved only by their own key.
- **The operator.** "approve 456's parked question" becomes that command,
  run with `--dry-run` first, as every send the operator makes is.
- **The dashboard.** A parked need's card shows the recommended option
  first, as item 44 builds it, with a copy button beside each option for
  its line, digest included. `c` copies the `approve` line of a need that
  holds one parked item, of a class the acts table lists as Decide by name;
  any other item's line is copied only from the button beside the option's
  Changes and Costs. The line the tick writes carries each waiting park's
  digest and options, so the page reads them rather than parsing the
  record. The page copies; it does not write
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
  reply into a comment by the person who sent it, replying to the forge's
  own notification email for the review thread works the same way, as long
  as the forge strips the quoted email from the reply; a reply that keeps
  it is a free answer. This path needs no Jig code, and carries the digest
  only when the person copies it.
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
`ask/lib/waiting.ts`). Today `jig ask` and `jig send` read only the
pull-request conversation and miss a reply on a parked thread, so moving
them adds the thread reads the re-arm makes, with the same rule for a
thread that cannot be read: the item is reported unread, never answered.
They move in one pull request, so no two of them disagree on whether an
item is answered. The reader takes the option names and the recommendation
from the record through `state/park-frame.ts`, which gains the record's
section splitter, kept free of the command code `framed-park.ts` imports.

### Showing what was decided

- **`jig ask --thread`.** A question entry carries its options (each name,
  and whether recommended) and its digest. An answer entry carries its
  `choice`, or `free: true`, or `stale` with the digest it named. These
  are added fields under `ask`'s version 1, as
  [addresses.md](addresses.md#what-the-thread-gains-for-the-hub) grows the
  thread.
- **The line and the dashboard.** A parked need whose answers are stale or
  disputed keeps its act and says which, with the options.
- **The [outcome log](../GLOSSARY.md).** The line each tick writes
  (`dispatch/lib/line-store.ts`) keeps every waiting park with its class,
  digest and the answers the tick read. When the tick of the host that owns
  the repository finds a park its previous line held gone from the ledger,
  it writes an event row from a [resolution receipt](../GLOSSARY.md), not
  from the disappearance alone: a park can leave the ledger answered,
  withdrawn or corrected between two ticks, and the line before it may hold
  no answer at all. The re-arm writes the receipt when it unparks an item:
  a stable identity (the park's key and digest), the consumed answer
  snapshot, the outcome and the times, kept in the drive ledger beside the
  park it resolved. The tick ingests every receipt whose identity its line
  has not yet recorded as ingested, whether or not a previous line held the
  park, so a park raised and answered between two ticks is counted; the
  line keeps the identities it has ingested, and drops one once the ledger
  no longer lists its receipt. The event row carries the class, whether the
  choice was the recommended option, the form, and how long the item
  waited; a park the previous line held that left with no receipt is
  counted as removed, not answered. The ledger is on the pull request, so a
  re-arm on any host is counted, as far as the owner's tick ran to see it.
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
give, to copy and to forge, and harder to notice; and since an answer's
time is its last edit, a token that can edit the person's comment can turn
their words into an approval, as it can turn them into any other answer
today. So Authorize items are
left out of `--all` and of one-key copying, and the classes whose wrong
answer cannot be undone wait on proof that a person answered:

- **Attested classes.** `autonomy.attested_classes`, by default
  `destructive`, `release` and `legal`, lists the classes whose answers
  count only with such proof. Answers are read by the re-arm and the
  tick, outside any pass, so each reads the setting itself from the
  repository's configuration at the head of the base branch, never from
  the pull request's own branch, which a pass could change. The setting
  arrives with the first proof item 40 builds, never before it: a setting
  with no proof to check would either do nothing or stop those classes
  being answered at all.
- **What counts as proof** is item 40's to choose, and one choice serves
  both. The candidates for answers, and what each needs:
  - **A pass identity of its own.** Passes post under their own forge
    identity, so the person's login is the person. This settles every class
    at once and is item 40's first candidate.
  - **A signature with a hardware-held key.** `jig send` signs the answer's
    fields (the pull request, the key, the digest, the choice, the time, and
    the answer's whole text or its hash with its structured or free
    classification, since a free answer has no choice to bind)
    with `ssh-keygen -Y sign` under a namespace of its own, with a key held
    by a security key that needs a touch, or by the operating system's key
    store configured to require a person's presence for each signature
    (on macOS an access control with `userPresence`, say); a store that lets
    a process of the same user sign without that interaction does not
    count. A key in a file does not count, even with a passphrase or a
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

The drive ledger's row in [plugin/RECORDS.md](../plugin/RECORDS.md) gains
each park's `digest` and the resolution receipt of each park a re-arm unparked. The `drive-answer` row gains the line's digest
suffix and the payload fields `decision` (the digest)
and `choice` (the option's name and the form). The hub's third stage ([hub.md § Build order](hub.md#build-order)) adds
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
   forms, normalizing, the whole-comment rule, edit times, several answers
   and the disputed item); every reader named in [Reading
   answers](#reading-answers) moved to it at once, `jig ask` and `jig send`
   gaining the thread reads, and `jig ask` labelling an answer structured,
   free or disputed in its text; the park's refusal of option names that
   collide; no provisional decision over an answered item; the kept
   answer's `choice`, the verdict's record and the pass notice; the
   disputing comments in the notice's key; `drive-pr`'s SKILL.md and
   README, the decision record's writing rules and the HITL registry
   template on an Authorize refusal option, and the mechanism map's entry.
   Waits on the record helpers
   [#674](https://github.com/jig-harness/jig/pull/674) exports. Done when a
   park answered `approve` hands the pass the recommended option, a
   `choose` naming no option reaches the pass as a free answer and `jig ask`
   labels it free, an approval beside another person's different answer
   leaves the item waiting, and the re-arm, the tick and `jig ask` agree on
   every item of a test pull request.
2. **The decision digest.** `ParkedItem.digest` stored at the park and
   published in the ledger, the digest suffix and the stale answer in
   `answer-forms.ts`, the stale comments in the notice's key, and the
   notification's answer lines with the digest. Done when a line copied
   from a notification counts, and the same line after the item was framed
   again leaves the drive parked and the next notification says why.
3. **Writing them.** `jig send … answer --approve | --choose | --all`, a
   correcting answer, the record's payload fields and its RECORDS.md row,
   and the operator's verbs. Done when a send naming no option is refused
   before it writes, `--all` leaves out every class the acts table does not
   list as Decide, and a person's second send replaces their first.
4. **Showing them.** `jig ask`'s question and answer fields, the
   dashboard's copy buttons and stale or disputed answers, the Orca
   panel's buttons, the waiting parks' digests and options on the tick's
   line, and the outcome log's answered-park event. Done when
   the panel, `jig ask` and the dashboard show the same options and the
   same choice for one park.
5. **Recommendation acceptance.** The per-class report in `jig dispatch
   log`. Done when it reports, from the outcome log alone, each class's
   parks, approvals of the recommendation and median wait.
6. **Attested classes**, with item 40's first proof, and
   `autonomy.attested_classes` in [CONFIGURATION.md](../plugin/CONFIGURATION.md).
7. **Beyond the drive**: the follow-up's question, the loosened ratchet
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
  ready on an approved `ready` park. Worth measuring first: step 5 shows
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

## Review

Reviewed on 2026-11-09 by two fresh-context agent sessions acting as
adversaries, before the first pull request that builds it: one read the
first draft, the other the design at commit `b0171a9a`, each against the
code it names and the designs and decision records it builds on.

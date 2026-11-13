# The line in a team's chat: notifications, answers and commands: design

**What problem this solves.** The [dispatcher](../GLOSSARY.md) tells a
person what needs them by writing a comment on a workspace card in Orca,
and the [dispatch dashboard](../GLOSSARY.md) shows the same needs to
whoever opens it. A team that lives in a chat tool sees neither until
someone goes and looks: a pull request waits hours ready to merge, a parked
decision waits for an answer nobody knew was asked, and a person who wants
to know where an item stands, or to start one, needs a terminal. With this
built, the line posts to the team's chat: a pull request ready to merge,
with its link; a decision with its options as buttons; each stop only a
person can settle. A person answers with a click, and asks or tells the
line with a command, from a phone as from a desk.

This is the design of [plan.md](plan.md) item 54. It adds a surface to
what is there, and no new decision about the work: the causes the tick
notifies ([dark-factory-dispatch.md](dark-factory-dispatch.md)), sorted by
where each is settled ([need-classes.md](need-classes.md)), framed as
decisions with named options and a digest
([structured-answers.md](structured-answers.md)), asked and told through
`jig ask` and `jig send` ([addresses.md](addresses.md)), and served for
several hosts by the [hub](../GLOSSARY.md)
([control-plane.md](control-plane.md)).
[ADR-0022](../docs/adr/ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md)
records the decision this design needs: a resident chat bridge, and whose
identity posts what a person clicks.

Slack is the first chat tool it binds to. Every part names its seam, so a
second tool (Microsoft Teams, Discord, Mattermost, Google Chat) is an
implementation beside it, and a tool that can only receive (ntfy, email)
takes the notifications alone.

## The rule

A chat is one more surface of the line, never a station of it. Everything
it shows is derived from the records the line already keeps, and every act
a person makes in it is one request of a kind the line already reads,
written through `jig send`'s writers with its checks. Nothing the line
does waits on the chat, and a chat that is down, unconfigured or removed
changes nothing the line does.

## How it works

### Tiers, each whole without the next

| Tier | What runs | What a person gets |
| --- | --- | --- |
| Messages | the tick, posting through a notification channel | ready to merge, each decision with its options, each stop only a person settles, a daily digest; one thread per piece of work, kept current |
| Buttons | a chat bridge, on the hub or on the host | a decision answered with a click, or in words through a form |
| Commands | the same bridge | where an item or a pull request stands, what waits on me, and the `jig send` verbs as commands |

A team stops at the tier that suits it. Messages need no process beyond the
tick and no route into any machine. Buttons and commands need the bridge
(below) and nothing more.

### Notification channels

Today a notification has one way out: the session runtime's `notify`
(`plugin/dispatch/lib/runtime/port.ts`), which on Orca sets a workspace's
comment and marks it unread. Delivery becomes a port of its own, a
**notification channel**, and the tick sends each cause through every
channel the machine file enables:

- **`orca-card`**, the comment and unread mark of today, moved behind the
  port unchanged, its suppression and its notices workspace included.
- **`slack`**, which posts with the chat's own API.

Each channel keeps its own suppression record: the state database's
`notices` table gains a `channel` column, with today's rows read as
`orca-card`, so a cause delivered to one channel and lost on the other is
retried on the other alone. The rules of `actions/notify.ts` hold per
channel: a cause counts as sent only on the channel's receipt, repeats on
`dispatch.renotify_after` while it stands, and backs off in the failure
ledger under `notice <channel> <key>` while delivery fails.

A notice becomes structured, so each channel renders it in its own way.
Beside today's text and key it carries the piece of work's
[address](addresses.md), the cause, the links (the pull request, the item,
the dashboard's Work page), the acts that settle it, and for a framed
decision its digest, its recommendation and each option with what it
changes and costs: the fields the tick's line already carries for the
dashboard. The text stays the fallback a channel that renders nothing else
posts.

Notices stay an owner duty of the host
([control-plane.md § Owner duties](control-plane.md#owner-duties)): the
host that owns a repository's notices posts them, under its owner lease
when it is enrolled in a hub, as it writes the Orca card today. The hub
posts nothing.

### What is sent

The chat is told what the tick already notifies, and nothing the line
settles by itself:

- **Ready to merge.** The `ready` cause, once per head: the pull request's
  link and title, its lane and the act it waits on (merge now, approve
  first, update next), and the pinned merge command to copy.
- **A decision.** A park with a framed decision, and every need item 50
  settles by an answer: the question, the recommended option first, each
  option with what it changes and costs, the digest, and the `jig send`
  line for each option to copy.
- **A stop only a person settles.** Every need whose
  [need class](../GLOSSARY.md) item 50's class table settles by a person
  alone, and every cause the tick notifies that the table does not class.
  A class the tick or the steward settles is never posted: it reaches the
  chat only when it escalates to a person, as it reaches the dashboard.
- **The host.** The failure causes (`action-failing`,
  `repository-failing`, `ticks-failing`) and, where every account a host
  bills is at its usage limit, when the first one reopens. These go to the
  host's channel, not to a piece of work's thread.
- **A daily digest.** At `chat.digest_at`, the first tick past that time
  posts one message: how many pull requests are ready to merge, how many
  needs wait on a person and on whom, what merged since the last digest,
  and the host faults standing, each linking to the dashboard's view. Its
  suppression key is the date in `chat.timezone`, so a missed tick posts
  it late, once.

### One thread per piece of work

A piece of work is one item and the pull request that delivers it. Its
identity is the item's key where it has one, and the pull request's number
where it has none; when a pickup's pull request opens, the pull request's
link to the item joins the two, and the thread opened under the item's key
carries on under the pull request. Station addresses
([addresses.md](addresses.md)) identify individual requests, never the
thread. A piece of work gets one top-level message in its channel, the
first time anything about it is posted, and every later notice about it is a reply in
that thread. The top-level message says where the work stands now, in the
board's own columns ([dispatch-board.md](dispatch-board.md)): coming,
picking up, driven, needs you, ready to merge, merged. The tick edits it
when the column changes, so a channel read from the top shows the line's
state, and the history is in the threads.

When a cause is settled, by any surface (the chat, `jig send`, the
dashboard, a comment typed on the forge), the tick edits the reply that
raised it: its buttons are removed and it says what settled it. For an
answer it names the choice and who answered, from the `drive-answer`
record's `via` and writer where one was written, and from the comment's
author where a person typed it; any other cause reads settled. A question
left showing after it was answered is the failure this prevents.

The thread's identity (the channel and the message ids of the top-level
message and of each reply, keyed by the work's identity and the notice key)
is a `chat-thread` record in the posting host's state database. Each
message carries its notice key in a metadata field Slack stores with it,
and a post is written to the record as pending first. A retry after a lost
response reads the channel's recent history for that key, adopts the
message found and its id, and posts only when none carries it, as
`actions/notify.ts` recognizes a cause already on its destination before
resending. When an
enrolled host's owner lease moves to another host, the new owner reads the
thread records back from the hub's copies of the old owner's reports
([control-plane.md § Build order](control-plane.md#build-order), its third
stage) and keeps posting into the same threads; before that stage, the new
owner starts new threads.

### Where a message goes

- **Channels.** The machine file names a default channel and, optionally,
  one per repository, by its forge name, and one for host faults.
- **People.** A notice that waits on a person mentions them, and is also
  sent to them as a direct message when `chat.direct` is on. The person
  comes from the notice (`waitsOn`, `assignedBy`, the drive's arming
  person), mapped from a forge login to a chat user by
  `serve[].chat.slack` in the machine file, or by the link each person
  makes on the hub (below), which the owner reads from the hub. A person
  with no mapping is named by login, not mentioned.
- **Quiet hours.** `chat.quiet`, in `chat.timezone` (the host's zone when
  unset), holds mentions and direct messages, never posts. A notice posted
  in quiet hours mentions nobody, and the tick replies once with the held
  mention at the first tick after quiet hours end, if its cause still
  stands; a cause sent once for the life of its key keeps its mention that
  way.

### The chat bridge

Buttons and commands need something to receive a click. Slack delivers an
interaction either to a public address it calls (a request URL) or over a
WebSocket the app opens to Slack (Socket Mode). The bridge uses Socket
Mode: it opens an outbound connection and listens on no socket, so no
machine gains a route from outside
([ADR-0011](../docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)).

The **chat bridge** is one resident process. For each interaction it:

1. checks the connection and the envelope: the event is from the
   configured workspace (the team and, on an enterprise workspace, the
   enterprise the setup pinned) and the configured app;
2. acknowledges at once, since Slack waits only three seconds and delivers
   an interaction again when it is not acknowledged in time, and admits the
   interaction durably as `pending` under its id. The acknowledgement
   means received, never authorized;
3. checks the chat user who made it is a member of the workspace, not a
   guest or a member of another workspace sharing the channel, and is
   mapped or linked to a forge login;
4. checks the login may read the target repository for a read and write to
   it for a write, from the forge's permission for that login. A read
   command filters what it shows to the repositories the login may read
   before rendering, and refuses an explicit target it may not read. An
   unmapped user, or a login without the permission, gets a private reply
   saying why, and nothing is shown or written;
5. runs the one request the interaction names, through `jig send`'s
   writers and with its checks: `answer <key> --choose <option> --decision
   <digest>` for a button, the framing-bound words writer for a form, the
   command's verb for a command, each carrying the interaction's id as a
   request id that the write records beside it;
6. edits the message, or replies privately, with what the request wrote or
   why it was refused, and marks the interaction `done`.

A request the send refuses changes nothing: a button whose decision was
reframed since it was posted fails the digest check, and the bridge
replies with the new framing's options. An interaction is run once: the bridge
keeps each id with its state, `pending` or `done`, for an hour. A
`pending` id met again, after a crash or a second delivery, is first looked
up in the write's destination for a record carrying its request id: found,
it is marked `done` and its result reported; not found, it is run. So a
write accepted by the forge and lost from the bridge's memory is never
written twice, and an admitted interaction is never lost. The bridge
keeps no other state, starts no session and is read
by nothing the line runs. Stopping it removes the buttons and the
commands, and the line goes on.

### Placements

The bridge runs where the team runs it, as one process in either place:

- **On the hub**, inside `jig hub serve`, for a hub's enrolled hosts. When
  the hub runs on a machine that runs no pass, this placement keeps the
  chat's app token and the bridge's forge key out of every pass's reach.
  A hub on the host that already dispatches loses that: `jig chat doctor`
  warns about it, and the attested classes stay off its buttons.
- **On a host**, as `jig chat serve`, installed like the dashboard's
  reader, for a host that is not enrolled in a hub.

One Slack app has one placement. Slack hands each interaction to one of an
app's open connections, not to all of them, so a host's bridge and its
hub's bridge on one app would each see some of the clicks. A host that
enrolls in a hub stops its own bridge at the next tick and says so in its
receipt, whichever Slack app either names: a host bridge runs only while
its host is not enrolled, so installation and enrollment cannot disagree.

Both placements post notices the same way: the owner host's tick, with the
app's bot token (above). The bot token posts and edits messages; the app
token that opens the bridge's connection, and on the hub the bridge's
forge key, stay where the bridge runs.

The hub's bridge writes only where the hub can: an answer, `hold`,
`release` and `drive` on the forge, and `assign` on the tracker.
[control-plane.md](control-plane.md) names these writes and the
permissions they need, since the hub otherwise writes nothing. A request
whose record lives in a host's working tree (`pause`, `resume`, `stop`,
`hold-push`, written to the drive's mailbox) is not offered through the
hub, which calls no host and steers no session: the command replies with
the host that holds the drive and the `jig send` line to run there.

### Whose identity posts a request

What a person clicks ends as a comment, a label or an assignment on the
forge or the tracker, posted under some identity. It depends on the
placement:

- **On the hub: the bridge's own app identity.** The team creates an app on
  the forge for the bridge (a GitHub App on GitHub), whose key only the hub
  holds, and gives the hub a tracker credential for `assign` where the
  tracker is not the forge. A request it writes says who made it: the
  `drive-answer` record, and for every other verb a `chat-request` record
  beside the write, name `via: chat`, the chat user, the forge login it is
  linked to and the time. No pass posts under this identity, so an answer
  from the chat is told apart from anything a pass could write. Each person
  links once, with `/jig link`, which signs them in to the forge through
  the app and records the pair on the hub; nobody keeps the map by hand.
- **On a host: the host's own forge credential.** The request is posted as
  `jig send` posts it from that host's terminal, with the same
  `via: chat` record naming the chat user, which only describes it: the
  answer is the host login's, as one typed in its terminal is. This widens
  who can act as the host's login, from whoever has a shell on the host to
  every chat user its machine file maps, so a host maps only the people it
  serves.

[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
makes a person's act with that person's credential and never through the
hub. A request through the hub's bridge is the one exception, decided in
ADR-0022: it is made with the bridge's identity, which attests the person
the chat authenticated, rather than with the person's credential.

#### Who may act

The readers of each record decide whether it counts, not the bridge:

- **An answer.** `shared/trusted-authors.ts` counts an answer posted by a
  bridge identity when the repository lists that identity under
  `chat.bridges` in its configuration at the head of its base branch (never
  the pull request's own branch), its `drive-answer` record names a linked
  login, and that login may write to the repository, read from the forge's
  permission for it. The answer is then that login's everywhere an answer's
  author matters: replacing an earlier answer, a dispute between two
  people's answers, the resolution receipt. A `via: chat` record on a
  comment the host's login posted never changes whose answer it is.
- **An assignment.** A pickup the host serves is one assigned by a person
  it serves (`assignedBy`). An assignment made by a bridge identity counts
  as the person the `chat-request` record beside it names, when the host's
  machine file lists that identity under `chat.bridges` and that person is
  one it serves.
- **A label** (`drive`, `hold`, `release`) counts as today: the tick reads
  labels from anyone who can write them. The bridge's own permission check
  is what keeps a linked person without write access from adding one.

### Buttons

Every option of a framed decision is a button, the recommended one first,
each carrying the address, the key, the digest, the park's occurrence (the
time it was parked, which the digest, a hash of the wording, does not
carry) and the option, never the answer's text. A confirmation carries the
same fields, and the occurrence is checked again immediately before the
write, so a message or an open confirmation from an earlier park of the
same wording is refused, as structured answers drops a pick when the same
wording is parked again. Which decisions get buttons, and which take two steps,
follows the guard structured answers sets for every surface
([structured-answers.md § Picking an answer](structured-answers.md#picking-an-answer)):

- A pick is **guarded** when the shared acts table (`shared/acts.ts`) does
  not list its class as Decide by name (an Authorize class, or a
  repository's own class), or its option is marked `reversible: false`. A
  guarded button opens a confirmation showing the option in full (what it
  changes and costs), and only the second click sends.
- Any other pick sends on the first click.
- **Attested classes** (`autonomy.attested_classes`: by default
  destructive, release and legal) get no buttons until item 40 accepts the
  hub's bridge, on a machine that runs no pass, as proof that a person
  answered. A host's bridge never offers them, since its identity is the
  passes' login. Their message carries the copy lines and the link.
- No button sends several answers: there is no "approve all".

Each decision whose writer accepts words, and whose class the placement may
answer (never an attested class a placement offers no buttons for), also
has an **Answer in words** button. A station decision that the tick carries
out as a named option (a follow-up, a pickup) has none, since the writer
refuses a free answer there. The button opens a form for one line of text
that carries the digest and the park's occurrence, and a framing-bound
writer (a `--decision` and occurrence on a free answer, which `jig send`'s
free answer does not take today) refuses the text when the park has been
reframed since the form opened, so the words always answer the question the
person saw. Both the button and the submission check the class, and the
text keeps `jig send`'s limits on an answer's text (one line, a length cap, no control
characters, no hidden marker). Words the readers would count as a choice
(`approve`, `choose Keep`) are refused and pointed to the buttons, as `jig
send` refuses them typed as free text. A reply typed in the thread is
conversation between people, never an answer.

### Commands

One slash command, `/jig`, with the line's verbs. Every answer to a read is
private to the person who asked.

| Command | What it does |
| --- | --- |
| `/jig ask <pull request, item or address>` | `jig ask`'s fixed card: holder, state, what it waits on, the last launch |
| `/jig needs [person]` | the needs that wait on the person, as the dashboard's What needs you lists them |
| `/jig status [repository]` | the dashboard's Now: counts per column, host faults, links |
| `/jig pickup <item>` | `jig send pickup@… assign` |
| `/jig drive <pull request>` | `jig send drive@… drive` |
| `/jig hold`, `/jig release <pull request or item>` | the `hold` label |
| `/jig pause`, `/jig resume`, `/jig stop <pull request>` | the drive's mailbox, on a host's bridge for a drive that host holds |
| `/jig link` | links the chat user to a forge login (the hub's bridge only) |

A command whose verb `jig send` would refuse is refused before anything is
written, with `send`'s reason. On the hub, the read commands answer from
the hub's view of every host, so they come with that view (the hub's third
stage). A pasted link to a pull request or an item unfurls into the same
card `/jig ask` gives, when `chat.unfurl` is on, only in a channel the
configuration names and only for a repository it routes to that channel.

### Safety

- **Every text from a record is untrusted.** A pull request's title, a
  park's question and an option's wording can be written by a pass or by
  anyone who opens a pull request. The channel puts such text in plain-text
  elements, which the chat renders without markup, and posts with link and
  media previews off, so a question cannot mention a channel or a person,
  or show a link it was not given; mentions and links are built only from
  the people map and the notice's own links.
- **The channel is the access control.** Everyone in a channel reads what
  is posted there: titles, questions and options from private
  repositories. A channel takes the repositories whose readers are its
  members, and `jig chat doctor` warns about a channel shared with another
  workspace or open to guests.
- **Buttons carry no authority.** A button's value names what to request;
  the request is checked as if typed, by a mapped or linked person with
  write access, against the station's current state.
- **Tokens.** The chat's bot token and app token, and the bridge's forge
  key, are read from the state folder of the machine that uses them,
  readable by its user alone, never from a repository and never from the
  machine file. On a host they are as safe as that host's other
  credentials; on a hub that runs no pass they are out of the passes'
  reach.
- **Limits.** Every call to the chat keeps the chat's own limits (Slack
  allows about one message a second per channel), has a deadline, and
  backs off under the failure ledger, through the governed outbound
  transport once the outbound-calls rule
  ([#1026](https://github.com/jig-harness/jig/pull/1026)) gives Jig one.

### Configuration

The values are the team's: the workspace, the channels, the people. They
arrive in the machine file on a host and in the hub's settings on a hub,
never in Jig.

```yaml
chat:
  slack:
    app: A0123456789              # the Slack app id the bridge checks
    team: T0123456789             # the workspace whose events count
    enterprise: E0123456789       # only on an enterprise workspace
    channel: C0123456789          # the default channel
    repositories:
      example-org/web: C0234567890
    host_channel: C0345678901     # host faults and the digest
  timezone: Europe/Berlin         # quiet hours and the digest's date
  direct: true                    # a direct message to the person a need waits on
  quiet: "20:00-08:00"            # posts, no mentions until it ends
  digest_at: "09:00"
  unfurl: false
  bridge: true                    # run `jig chat serve` on this host
  bridges: [example-jig-bridge]   # bridge identities whose assignments this host counts
serve:
  - name: alice
    forge: [alice]
    chat: { slack: U0123456789 }  # a host's map; the hub links people instead
```

A repository says which bridge identities may answer for it, in its own
configuration, read at the head of its base branch:

```yaml
chat:
  bridges: [example-jig-bridge]   # the forge app the team's hub posts as
```

Both lists name the same thing, a bridge whose records are trusted, at the
scope each reader owns: the repository for its answers, the host for the
assignments it serves.

### Records

Each is registered in `plugin/shared/records/registry.ts` and listed in
[plugin/RECORDS.md](../plugin/RECORDS.md):

- the `notices` table's `channel` column, an additive migration;
- `chat-thread`, in the posting host's state database: the channel and
  message ids of a piece of work's thread and of each notice's reply,
  keyed by address and notice key, and reported to the hub where the host
  is enrolled;
- `chat-handled`, on the bridge's machine: the ids of the interactions it
  admitted, each with its state (`pending` or `done`), kept an hour;
- `chat-link`, on the hub: a chat user and the forge login they linked;
- `chat-request`, on the forge or the tracker beside the write it explains:
  the verb, the chat user, the linked login, the request id, the time;
- `drive-answer` gains `via` and the chat user as payload fields, under
  version 1.

### Setting it up

The plugin ships the Slack app's manifest (`plugin/chat/slack/manifest.yaml`),
with Socket Mode on and the scopes the tiers use: posting and editing
messages, direct messages, the `/jig` command, reading the workspace's
members for the membership check, and link unfurling. A team creates the
app from it, installs it to their workspace, and gives Jig its tokens:
`jig chat setup slack` stores the bot token on each host that posts and
the app token where the bridge runs, pins the team and enterprise from the
installation's authenticated metadata (refusing a configuration that names
others), and posts a test message to each
channel the configuration names. `jig chat doctor` checks the tokens, the
channels and who can read them, that one placement holds the app, and for
the hub's bridge the forge app's installation on each repository that
lists it and whether the hub's machine runs passes.

### Other chat tools

The seams are the notification channel, which a receive-only tool
implements alone, and the bridge's interaction source, which turns a
tool's click or command into the request the bridge runs. Microsoft Teams,
Discord and Mattermost each deliver buttons and commands to a bot over a
connection or an endpoint, and fit the same bridge; none is designed here
beyond the seam.

### Where it lives

`plugin/chat/`: the channel port and the Slack channel
(`plugin/chat/slack/`), the bridge (`plugin/chat/bridge.ts`) and the
commands, registered in `plugin/jig.ts` as `jig chat`. The `orca-card`
channel stays in `plugin/dispatch/lib/runtime/`. The hub starts the bridge
from `plugin/hub/` when its settings name a chat.

## Build order

One pull request per step, each shippable alone:

1. **The notification channel port.** `orca-card` moved behind it, the
   `notices` table's `channel` column, the structured notice. Nothing a
   person sees changes. Done when today's notification tests pass through
   the port and a cause lost on one channel is retried on it alone.
2. **The Slack channel.** Ready, decisions, person-only stops and host
   faults posted with their links and copy lines; the thread per piece of
   work, its top-level message edited per column and each reply edited when
   its cause settles; channels, mentions, direct messages and quiet hours;
   the manifest, `jig chat setup` and `jig chat doctor`. Done when a parked
   drive on a test repository posts its decision to a channel, the answer
   typed on the pull request edits the reply to answered, and the pull
   request becoming ready posts one reply and moves the top-level message.
3. **The digest.** Done when a host posts one digest a day, late once after
   a missed tick.
4. **The bridge on a host.** `jig chat serve`, its installation, the
   workspace, membership and permission checks, buttons with the guarded
   pick, the Answer in words form, the `chat-request` and `chat-handled`
   records. Done when a click on a parked decision's option re-arms the
   drive with that choice, a click on a reframed decision is refused with
   the new options, and an interaction delivered twice posts one answer.
5. **Commands on a host.** `/jig ask`, `/jig needs`, `/jig status`, then
   `pickup`, `drive`, `hold`, `release`, `pause`, `resume`, `stop`, and
   unfurls.
6. **The bridge on the hub.** The bridge's forge app identity and the
   hub's tracker credential, with the writes named in control-plane.md;
   `/jig link`; `chat.bridges` in `trusted-authors.ts` and in the
   served-person check, with the permission lookup; the forge and tracker
   verbs; a host's bridge standing down. Waits on the hub's first stage
   (item 49), and offers drive parks only: the station decisions' writers
   need the dispatching machine's newest line, which the hub reads from
   hosts at its third stage, so their buttons wait for step 7. Done when an answer clicked in a chat whose bridge runs on
   the hub is read by the host's re-arm as the linked person's, and a
   linked person without write access is refused.
7. **Across hosts.** The read commands from the hub's view of every host,
   and a new owner keeping its predecessor's threads. Waits on the hub's
   third stage.
8. **Attested classes on the hub's bridge**, once item 40 accepts the
   bridge on a machine that runs no pass as proof.

## Left out

- **Merging from the chat.** A person merges
  ([ADR-0003](../docs/adr/ADR-0003-a-person-merges.md)), and a click
  carried out under the bridge's identity is not the person merging. The
  ready message gives the link and the merge command. Revisit with
  delegated merge (item 9), or with a merge made under the person's own
  credential.
- **A drive's mailbox through the hub.** `pause`, `resume`, `stop` and
  `hold-push` reach a drive only on the host that holds it, and the hub
  calls no host and steers no session. Revisit if the hub's host protocol
  gains a request a host collects, bound to a driver generation and
  expiring.
- **Each person's own forge token on the bridge.** It would make every
  answer look like the person's own, which is what makes it impossible to
  tell from a pass's, and it puts every person's credential on one machine.
- **A request URL.** It needs an address the chat tool can reach from the
  internet, which Socket Mode avoids. A team that cannot open an outbound
  WebSocket has messages without buttons.
- **Incoming webhooks.** They post but cannot edit, and editing is how a
  message stays true.
- **Thread replies as answers.** People talk in a thread; an answer the
  re-arm has read cannot be taken back, so only a button or the form
  answers.
- **Free-text questions to an agent** ("why is this stuck?"). The bridge
  starts no session; a question an agent answers belongs with dispatched
  sessions, and comes later.
- **An app listed in Slack's directory.** An app that uses Socket Mode
  cannot be listed there, and Jig runs no hosted service; each team makes
  its app from the manifest.
- **"Approve all"** from the chat, for the reasons structured answers
  keeps `--all` off one-key copying.

## Review

Critiqued on 2026-11-13 by a reviewer with fresh context (a subagent that
did not write it), against the draft of this design, its plan item and
ADR-0022 on top of commit `241bfe1f`.

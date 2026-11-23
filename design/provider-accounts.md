# Provider accounts and an agent-harness interface: design

**What problem this solves.** The [dispatcher](../GLOSSARY.md) bills every
launch to a subscription account and runs every stage on Claude Code or
Codex. A host that holds its own key with a model provider cannot have the
dispatcher use it. Launch environments remove the vendors' credential variables, and a
provider's own key never reaches a pass. A Claude
account's identity is a login email. A provider's refusal is read as a
subscription [wall](../GLOSSARY.md): a 429 parks the account for an hour as an
unknown wall, and a 402 is a plain pass failure that is tried again on the
next tick. Model identifiers are a closed list. Nothing records what a pass
cost, and the choice of agent is a two-value type spread through the code.
With this built, a host lists provider accounts beside its subscriptions. Each
has a reference to its credential, a [spend cap](../GLOSSARY.md) when it is metered, and a
provider the repository allows. Every pass's cost is in a ledger, a 429 is
waited out and a 402 parks one account with one need. A model outside the
known families is routed by configuration alone, and a third
[agent harness](../GLOSSARY.md) is one implementation behind an interface.

This is the design of [plan.md](plan.md) item 59, decided in
[ADR-0026](../docs/adr/ADR-0026-the-agent-harness-is-an-interface.md) (the
agent-harness interface) and the amendment of
[ADR-0021](../docs/adr/ADR-0021-outbound-calls-are-governed.md) that brings
model providers under the rule for outbound calls. How a provider's limits,
failures and costs are governed is in
[outbound-calls.md § Model providers](outbound-calls.md#model-providers); this
page holds the account schema and everything else the build steps read.
The harness interface is built, with Claude Code and Codex behind it
(`plugin/shared/agent-harness/`). The account kind, the credential command, the identity forms and the
provider allow list are built, the list applying to dispatch launches; a
provider account is reported as configured and not admitted while the
provider admission hold stands, which comes off only once the spend-cap work lands together with the endpoint-routing, redaction and original-transcript work. The
rest is not built yet: the allow list's reach over the measurement's replays
and the repository need when no allowed account exists, redirect
refusal and a minimum length beyond 8 characters are not enforced, and the
spend cap below is the design, not a shipped control.

## How it works

### What an account is

The machine's dispatch file (`~/.jig/dispatch.yaml`, documented in the
[configuration reference](../plugin/CONFIGURATION.md)) lists the accounts the
dispatcher may bill. An entry today has the keys `name`, `vendor`,
`config_dir`, `identity`, `max_per_account` and `stages`. Its `vendor` is
`claude` or `codex`, and it names both the program that runs and the company
that bills.

An entry gains a **kind**:

- **`subscription`** (the default, so every entry that exists keeps its
  meaning). A flat fee, a vendor's usage limits and a login kept in
  `config_dir`. Nothing about it changes except that its vendor is now checked
  against a repository's [provider allow list](#the-provider-allow-list).
- **`provider`**. Pay-per-use against a model provider with the host's own
  key.

A `provider` entry has these keys. A key not listed is refused, as every
unknown key in the file is.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | as today | required | The account's name; unique, as today |
| `kind` | `provider` | required for this kind | |
| `harness` | a registered harness (`claude-code`, `codex`, and `pi` once built) | required | The agent harness the account's passes run in |
| `provider` | lowercase name, `^[a-z][a-z0-9-]*$` | required | The provider the account bills, spelled as a repository's allow list spells it (`openrouter`, `gemini`, `anthropic`) |
| `base_url` | an `https://` URL | the harness's own default, allowed only for `anthropic` on `claude-code` and `openai` on `codex`; otherwise required | Where the harness sends its requests. A non-HTTPS URL is refused, except a loopback address. The path carries no percent escape and no credential-shaped value, so a URL whose path does is refused. The host must be one the provider's profile names, or be named in the machine file's `provider_hosts` for that provider. Refusing a redirect to another host is deferred and not enforced today. A loopback or private-network address is admitted only when the machine file names it for the account |
| `credential` | a [credential reference](#the-credential-reference) | required | Never the credential itself |
| `billing` | `pay-per-token` or `flat-rate` | `pay-per-token` | A `flat-rate` plan has no `spend_cap`: its own usage windows bound it, through the account's wall and `max_per_account` |
| `spend_cap.daily` | decimal US dollars, as a string | required for `pay-per-token` | The day's [spend cap](#the-spend-cap) |
| `spend_cap.per_run` | decimal US dollars, as a string | none | The ceiling of one pass |
| `spend_cap.timezone` | a time zone name such as `Europe/Amsterdam` | `UTC` | Where the day starts |
| `models` | list of `{id, price}` | none: any model the harness accepts | The models the account may run. A launch whose route names a model outside a given list is refused with that reason. Where the provider reports no cost, `price.input` and `price.output` give what each costs in dollars per million tokens |
| `config_dir` | absolute path | `~/.local/state/jig/harness/<name>` | The directory the harness runs with: its own state, and none of the host's configuration of that harness |
| `max_per_account` | whole number | 2 | Slots, as today |
| `stages` | subset of `pickup`, `rearm`, `followup`, `steward` | as today | The stages the account may serve |

`vendor` and `identity` are not keys of a `provider` entry: the provider is
named by `provider`, and the identity is [derived](#the-identity-of-each-kind-of-account),
never configured. The existing uniqueness rules hold, and `config_dir` is
unique across every account of both kinds, so a provider account cannot share
a subscription account's directory.

A **subscription** entry may also name a `harness`, for a plan whose login a
third-party harness may use (see [the trial](#the-harness-trial)). It defaults
to the harness of the vendor's own program. The loader refuses a Claude
subscription (`vendor: claude`) with any harness but `claude-code`, so a Claude
Pro or Max login never reaches another harness; no entry carries a Google
consumer login at all.

The stages are the dispatcher's launch stages: `pickup` (a `do-item` pass),
`rearm` (a drive-pr pass), `followup` and `steward`. The routing rows, the
harness profiles and the ledger's operations use these names.

```yaml
credential_command: [op, read, --no-newline]   # see the credential reference
accounts:
  - name: work                       # a subscription account, unchanged
    vendor: claude
    identity: me@example.com
    config_dir: ~/.claude
  - name: gemini-trial
    kind: provider
    harness: pi
    provider: gemini
    credential: op://Jig/gemini-trial/credential
    spend_cap: {daily: "20.00", per_run: "2.50"}
    models:
      - id: gemini-4-neon
        price: {input: "3.00", output: "15.00"}
    stages: [rearm]
```

A launch on a provider account carries that account's credential and no
other. The environment the launch starts from is the one a subscription
account's launch starts from: the vendors' credential variables
(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) removed,
and with them every other provider key, such as `GEMINI_API_KEY` and
`OPENROUTER_API_KEY`, which a launch carries today. Each removal is by
name whatever its letter case (#860 asks for the case-insensitive match, which
is one function used by both kinds, so a mixed-case name that survives on a
case-insensitive platform survives for neither).
Then the harness implementation's `environment` operation adds the account's
resolved credential under the variable name its program reads, and its base
URL. A subscription account's launch adds only its configuration directory,
as today; its credential is the login in that directory.

### The credential reference

A credential in the configuration is a **reference**, an opaque string such as
`op://Vault/item/field`, and its value is never written in any file Jig reads
or writes. The host chooses how a reference is resolved with one key of the
machine file:

```yaml
credential_command: [op, read, --no-newline]
credential_timeout: 10s
```

The contract of the command:

- It is an argument list, run without a shell. Jig appends the reference as
  the last argument, as one argument, so a quote or other shell character in a reference is not interpreted. The loader itself refuses a reference with whitespace in it, so address a vault item whose name has a space by its item ID, which 1Password's reference syntax accepts in place of the name.
- It runs with a small base of the host's environment (`PATH`, the home, the
  user, the locale and the temporary directory) and the variables
  `credential_env` names, such as a vault's session or service-account token
  (`OP_SERVICE_ACCOUNT_TOKEN`), never the pass's. A host whose vault needs a
  variable lists it there.
- Its standard output is the value. One trailing newline is removed. A value
  that is empty, holds a newline or a null character inside it, is under 8 characters (UTF-16 code units, as the masking counts them) or is over 4 KiB is refused.
- It succeeds with exit 0 within `credential_timeout` (10 seconds by
  default). A non-zero exit or an empty value is `unauthorized` for that
  account: the credential is missing, expired or refused. The account is held
  with the reason, the dispatcher raises one host need for the account, and an
  account on another provider keeps launching. A timeout is `unreachable`: the
  launch waits for the next tick, as for any system that did not answer.
- Jig resolves it at each launch and keeps the value only in the launching
  process's memory and the pass's environment. The value is never written to a
  launch record, a receipt, the ledger, an error message or a command line.
  Every place text is recorded (stdout, stderr and the transcript copy) masks
  the **exact resolved value** as well as by
  [`plugin/shared/credentials.ts`](../plugin/shared/credentials.ts), whose
  pattern masking recognises only credential-shaped text and cannot catch an
  opaque value printed alone. The transcript copy does not mask a value cut
  partway, so the guarantee is not yet complete.
- `credential_command` is read only from the machine file, so a repository
  cannot choose what runs on the host. With no command, a provider account is
  refused at load with that reason. 1Password's `op://` form is one
  implementation. Any command that prints a value for a reference is another.

### The identity of each kind of account

An account's identity is what the dispatcher compares a launch's account with
before it starts anything, what the budget record keys a quota by and what a
drive's lock names so a re-arm lands on the same account.

| Account | Identity |
| --- | --- |
| Claude subscription | The login email in `config_dir`'s `.claude.json`. The forms `token:<fingerprint>` (from `CLAUDE_CODE_OAUTH_TOKEN`) and `api-key:<fingerprint>` (from `ANTHROPIC_API_KEY`) exist in the resolver, and a launch never meets them, since its environment has those variables removed |
| Codex subscription | The login email in the `id_token` of `auth.json`, else the `account_id` |
| Codex with a key | `api-key:<fingerprint>`, from `OPENAI_API_KEY`, or from `auth.json` with `auth_mode: apikey`. The fingerprint is the first 12 hexadecimal characters of the SHA-256 of the key, so the identity names the key and the key is not recoverable |
| Provider account | `provider:<provider>:<fingerprint>`, where the fingerprint is the first 12 hexadecimal characters of the SHA-256 of the credential **reference** and the base URL, joined by a newline |

A provider account's identity hashes the reference and not the value. Rotating
the key behind a reference then keeps the account's caps, ledger and walls,
and resolving the identity needs no secret. The cost is that two references to
one key are two accounts, which the file's author controls. The drive's
account hash (`acct-<16 hex>`) is computed for a provider account from its
identity. It is `null` for a `token:` or `api-key:` identity: a fingerprint
never proves which account a wall belongs to, since two credentials can bill
one account, and the comparison then resolves toward stopping. A provider
account's identity is the account by definition, since the reference is what
the file's author declared to be it.

### The spend cap

Every pay-per-token provider account has a **daily cap** and may have a
**per-run ceiling**. A flat-rate provider account takes no cap, and a
subscription account has neither: its limit is the vendor's.

- **The day.** A day runs from midnight to midnight in `spend_cap.timezone`
  (UTC by default). The cap refills whole at the boundary and the refusal's
  reset time is that boundary. A host whose provider bills in another zone
  sets its zone; the provider's own limit is the hard backstop and should be set
  at or above the daily cap. The budget record keeps each account's spend under
  the account's date in its zone, so a zone whose offset is not a whole hour
  needs no special case; the record holds a week of days. `daily` and
  `per_run` must be positive; a zero or negative value is refused at load.
- **What counts.** The day's spend, kept in the budget record, is the cost of
  every pass that ended that day with a reported cost, plus the reservations
  of the passes running now, plus the full reservation retained for a pass that
  ended with no report or with an unknown cost. A pass counts on the day it
  ends. The [ledger](outbound-calls.md#model-providers)
  holds the same costs as hourly totals for reports, and each pass's own cost
  is on its launch record.
- **Admission is per launch.** Jig does not send the model requests, so it
  cannot refuse a request. It admits a launch if the remaining cap covers its
  reservation, and refuses it as `rate-limited` until the boundary if not. A
  remaining cap of zero or less covers nothing, whatever the reservation. The
  reservation is the per-run ceiling when the account has one, else the mean
  cost of the account's last 20 passes, from its launch records, else one tenth of the daily cap.
- **The cap is not a hard stop.** A pass that costs more than its
  reservation finishes and the day's total is recomputed with its real cost; the
  next launch is refused only if the remaining cap then fails to cover its
  reservation. The per-run ceiling is the bound on one pass: it is passed to the
  harness as its own budget limit where the program has one. Where it has none,
  the ceiling is checked against the usage reported when the pass ends, and a
  pass over it is recorded and raises one need naming the account, the pass and
  both amounts.
- **Reporting.** A day's spend that would pass the cap before the day ends, at
  the rate of the last hours, raises the low-quota need of the ledger, naming
  the stages that spent it. A cap that has been reached shows on the dashboard
  with its boundary.
- **A unit.** The ledger records a provider account's cost in micro-dollars
  (millionths of a US dollar) and the cap is compared in the same unit, so
  neither a float nor a currency string sits in a row.

### The open model vocabulary

Today the model names a tier may map to are a closed list of families
(`plugin/shared/model-families.ts`, with the loader's refusal of an alias
outside it unless `routing.family_tiers` waives it with a reason). The list
stays as the **defaults**, and it stops being an allowlist.

- `routing.models.<harness>.<tier>` accepts any model identifier the harness
  accepts, not only a family alias. The harness's key is a registered harness,
  or any runtime key that matches the loader's pattern as today.
- `routing.model_tiers.<harness>.<model-id>` gives a model outside the list its
  capability tier, one of the tiers of the
  [model routing policy](../modules/M0-instruction-architecture/reference/model-routing-policy.md),
  and a reason. It replaces `family_tiers` as the way to say what a name is
  worth, and `family_tiers` entries are read as its entries. A model with no
  entry is **refused** (fail closed) wherever a route needs its capability
  tier: names stay open, but an identifier outside the defaults must declare
  its tier in `model_tiers` before a route uses it. A Scout-tier model is still
  refused for an implementer, and that refusal cannot be waived.
- A tier maps to a model **per stage** as well:
  `routing.stages.<stage>.models.<harness>.<tier>`, for the stages the
  dispatcher launches (`pickup`, `rearm`, `followup`, `steward`).

**Precedence.** The layers of the
[configuration reference](../plugin/CONFIGURATION.md#configuration-layers)
apply (environment over repository over user), and a stage's row is more
specific than the row for all stages. For a stage, a harness and a tier the
dispatcher takes the first of: the stage's row at the highest layer that sets
it; the all-stages row at the highest layer that sets it; the default. A host
that sets the steward's model in its user file gets it in every repository,
unless a repository sets that stage's row itself.

The family list's role in the audit and in the route's reasons is unchanged.

### The provider allow list

A repository names the providers its code may be sent to, in its own
`dispatch` section of `.config/jig.yaml`:

```yaml
dispatch:
  allowed_providers: [anthropic, openai, openrouter]
```

- **The key and its values.** `dispatch.allowed_providers` is a list of provider
  names, spelled as `provider` is in a provider account, and `anthropic` for
  Claude Code's subscription accounts and `openai` for Codex's.
- **Where it is read.** From the file as the default branch holds it on the
  forge, by the dispatcher's forge reader and its section parser, never from a
  checkout. A branch, the user file and the environment cannot set it, so an
  unreviewed branch cannot widen it. The machine's file chooses the accounts
  that exist and the repositories the host serves, and cannot add a provider
  the repository's list lacks.
- **What an absent list means.** The repository uses the accounts it uses now:
  the Claude and OpenAI **subscription** accounts. A `provider` account is
  never admitted by an absent list, even one whose provider is `anthropic` or
  `openai`: it needs the list to name its provider. Every new provider is
  opt-in per repository. This is a default, open to the person: the ruling that a
  repository with no list has no provider outside those two accounts stands
  unless the person rules otherwise.
- **A subscription account is checked like a provider account.** The vendor is
  the provider: Anthropic for Claude Code, OpenAI for Codex. A repository whose
  list names only `openrouter` therefore has no launch on a Claude or Codex
  subscription account, since its code would reach those vendors too. An
  absent list is the list `[anthropic, openai]` for subscription accounts
  only.
- **Its reach.** Every launch that sends the repository's code or its tracker
  text to a provider: pickups, re-arms, follow-ups, steward passes and the
  [measurement's](#measuring-a-fast-decision-model) replays (planned: the
  measurement is built later, and the list applies to dispatch launches now). A session a person
  starts is the person's. A harness that routes onward (OpenRouter forwards to
  the model's own provider) is allowed by the name the list holds; the list does
  not name the providers behind it.
- **A refused launch.** The launch does not start and nothing is reserved. Its
  receipt and the dashboard line give the reason `provider-not-allowed`, naming
  the provider and the repository, as any other hold does. It raises no need
  per launch. Planned, not built: a repository that has work ready and no
  account on the host that its list allows raises one need for the
  repository, which clears when the list or the accounts change.

### The harness profile of a stage

A stage (`pickup`, `rearm`, `followup`, `steward`) runs under a **harness
profile**: the configuration the harness starts with, kept apart from the
host's own configuration of that program. A profile has these parts:

- **Jig's base profile for the harness**: the instructions, skills and settings
  Jig supplies. For a third-party harness it disables that program's login with
  a Claude Pro or Max subscription.
- **The repository's additions**: instructions, system-prompt text and skills
  a repository names under `dispatch.profile.<stage>`, read from the default
  branch like the allow list. They add to the base profile and never remove from
  it.
- **Extensions that run code**, such as a harness's own plugins or hooks, load
  only from the host's allowlist in the machine file
  (`harness_extensions.allow`, a list of names and checksums). A repository
  cannot add one.
- **A directory of its own**: the profile is built under the account's
  `config_dir` for the launch, never in the host's `~/.claude`, `~/.codex` or
  pi directory. A profile writes no credential to disk: the credential reaches
  the program through its environment only.

Claude Code and Codex keep their accounts' `config_dir` as the profile until
their profiles are built, and a subscription account's login stays in it.

### The harness trial

pi is an opt-in third harness, proven on one stage first: drive-pr passes on
one host's trial accounts. OpenRouter and the Gemini API are provider accounts.
The rest are plans whose vendor sells a login or a key: a plan's key makes a
provider account, and a plan that gives only a login makes a subscription entry
with a `harness` key, where the vendor's terms allow it:

- OpenRouter, through `OPENROUTER_API_KEY`;
- the Gemini API with a key, through `GEMINI_API_KEY`, running Gemini 4 Neon;
  Vertex AI is the other documented route, through `GOOGLE_CLOUD_API_KEY`, or
  Application Default Credentials with `GOOGLE_CLOUD_PROJECT` and
  `GOOGLE_CLOUD_LOCATION`;
- an OpenAI subscription login, only once OpenAI's own wording allows a third-party
  harness;
- OpenCode Go;
- a Z.ai coding plan, with the caution its terms of use give;
- a MiniMax M Plan.

A Claude Pro or Max login and a Google consumer subscription login (Gemini CLI
or Antigravity OAuth) are **never** routed through pi or any other third-party
harness: the profile disables the first, and no account kind carries the
second. opencode is the alternative if pi fails. An Antigravity CLI harness is
a later implementation of the same interface, with the same rule.

The trial records, for each pass, its cost, the rounds the drive took to
converge, how it ended and how often it parked, beside the same figures for the
host's subscription passes over the weeks before. Whether pi or any third
harness becomes a default is a ruling a person makes from that record.

### Measuring a fast decision model

The dispatcher's deciders are language models running on a subscription. Some
of their decisions are narrow enough that a fast model might make them. The
first step is **one offline measurement and nothing that switches**: a fast
model is scored against today's decider on decisions already recorded, the
steward's first.

**The model set.** z-ai/glm-5.3-flash and claude-haiku-5.5, both through
OpenRouter. The calls go through the provider transport the spend-cap step
builds, on a provider account of their own whose `provider` is `openrouter`,
with its own cap and per-run ceiling.

**The records.** The steward's recorded runs: the digest the steward was
given, and the records it submitted (`rearm`, `resume`, `need`, `facet`,
`order` and `cause`), kept in the dispatcher's state. The replay set is every
run at least 7 days old whose digest is still retained, so each record's
outcome is known and the input is intact. A run whose output the dispatcher has
erased after retention is left out. A repository
contributes only if its allow list names `openrouter`, and the digest is sent
as recorded, masked by `credentials.ts`.

**The truth.** The decider's record as it was made, except that a record a
person reversed or cleared is scored as the person's answer.

**What is scored.** Most steward records are `need`, so raw agreement rewards
always answering `need`. The measurement scores each record kind
**one against the rest**, over every (run, target, kind) record, where a
target may carry several records of different kinds, and several of one kind
that differ in their identity (a facet's name, for example). A record matches
the decider's when kind, target and identity agree; a duplicate counts once. A model
that always answers `need` has no recall on any other kind and no precision on
`need`'s absences. For each kind it reports precision, recall and field
agreement (the fields a record's shape requires of a match, such as the target
and the act of a `need`).

**The pass threshold, per record kind.** A kind with fewer than 30 records in
the replay set is reported and given the verdict `insufficient`, never `pass`;
for `order` the count is the scored runs, so thirty recorded orders that are
all too short to score are `insufficient` too.

| Kind | Precision | Recall | Field agreement on matches | Why this bar |
| --- | --- | --- | --- | --- |
| `need` | 0.90 | 0.95 | 0.85 (the target and the act) | A missed need leaves a person unaware; a spurious one is noise they read |
| `rearm` and `resume` | 0.98 | 0.90 | 0.98 (the target and the account) | A wrong action starts a pass or moves a drive |
| `facet` | 0.95 | 0.85 | 0.90 (the facet and its value) | A wrong value mislabels an item |
| `cause` | 0.90 | 0.90 | 0.90 (the class) | A diagnosis a person reads |
| `order` | not scored | not scored | A run is scored when the recorded order holds at least 3 targets. Its score is 0 when the proposed order names fewer than 0.80 of the recorded targets, else the Spearman rank correlation over the targets both hold. The mean over scored runs is at least 0.80 | Few records; an order is a ranking, and a partial order must not pass by naming only the easy part |

The report's **verdict** is decided in this order: `not adequate` if any kind
with enough records fails its row (the report names it and the figure);
otherwise `insufficient` if any kind that decides what the steward does has
fewer than 30 records; otherwise `adequate for a steward trial`, which needs
every such kind to have enough records and pass its row. The report also gives the median
latency and the cost of the replay against the decider's, as figures and not
as a gate. A verdict that is `adequate` changes nothing: using a fast model for
a stage is a separate decision a person makes and a separate change.

### Skills in a neutral form

A skill's text names no harness. It refers to its own directory through a
substitution the harness fills in where the program has no variable for it, and
to the structured question through a named fallback: a numbered plain-text
question that ends the turn, where the program has no tool for it. A skill
that needs a capability says so by name (`background tasks`, `subagents`) and
the implementation's `capabilities` answer whether the harness has it.

## Build order

The sub-issues of the epic, one pull request each. The first wave:

- **This design**, the ADR and the amendment.
- **The open model vocabulary**: the loader accepts any identifier, adds
  `routing.model_tiers` and the per-stage rows.
- **The provider account kind**: the machine file's entry, the credential
  command, the identity forms, the allow list's key in the section parser and
  the admission check that reads it, and #860's removal made case-insensitive.
- **The spend cap, the cost ledger and the provider failure classes**: the
  budget record's day, the ledger's micro-dollar rows, the 402 and 429
  policies and the provider transport.
- **The harness interface** with Claude Code and Codex behind it, and the
  neutral forms of the skills.
- **The measurement**: the replay, the report and its verdict.

Later: pi as an opt-in third harness on one stage; per-stage profiles; and the
ruling on a default harness from the trial.

## Left out

- **A request-level budget.** Jig does not send the harness's model requests.
  Admission is per launch.
- **A proxy or gateway** every harness's requests go through. It would count
  requests exactly, and it is one more process to run and secure on every host,
  which [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md) declines.
- **Automatic failover to another provider.** A refused launch may go to
  another account of the same provider and harness that the repository's list
  allows. It never moves to another provider on its own.
- **Dollar caps for subscription accounts.** Their limit is the vendor's, read
  as a wall.
- **A fast model that switches on its own.** A measurement's verdict is
  information for a person.
- **An Antigravity CLI harness and a default-harness ruling.** Later steps of
  the epic.

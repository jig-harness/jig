# Steward: recover routine waits and frame a person's decisions

As throughput grows, stopped work accumulates beside decisions only a person
can make. Without a steward, someone must read every log to tell a passing
failure from a decision and order assigned work whose fields leave ties.

The steward is a dispatcher-launched agent pass. It reads a digest and writes
records from a closed list
([the steward records chapter](../../protocol/steward-records.md)); the next
tick checks and applies them using the dispatcher's launch guards. It can propose another attempt for a transient stop, one fixed
resume for a routine question with a recommended option, a missing priority,
type or size, and the order of items tied under the queue's rules. Each
missing-facet proposal records the steward and its reason on the issue.
It frames the act and ask for a need that remains a person's and arrived
with no framing; a need its pass, its drive or the tick already framed as a
decision is left as it is.

A pickup's or a follow-up's run that ended without a closing report, and
whose end its wrapper could not explain, is listed in the steward's digest
with an excerpt of its transcript: its last assistant turns and every tool
error after its last success. The steward reads the excerpt as evidence and
records the run's cause, from a closed list, with a short summary of what
the run had got to; the next tick writes it onto the run's line in the
outcome log as its closing report, by the steward. It writes nothing to the
tracker, runs no CI and starts no pass. The steward's own passes are never
put to it: one that leaves no report is recorded by its wrapper. Without the
steward, or once its hourly passes are spent, the run stays "ended without
a report" on the dashboard, with the path of its transcript's copy on the
host. The copy is kept seven days after the cause is recorded, and at the
latest for the machine file's `receipts_days`.

A resume the tick cannot apply is refused once, with its reason, and the
digest then stops offering that pass: the pass framed a decision for a person,
ended done, was already resumed, or holds no single recommended option. A
refusal that depends on something that can change leaves the pass offered:
the autonomy policy's human-decision classes, or a pass the steward named
that is not in its digest or has not ended.

Before filling a field, the tick re-reads the assignment and the field after
recording its proposal. A value found nonempty is preserved. Tracker APIs
do not combine that check and the write into one operation: a human edit
between the requests can still be overwritten. Review this limit before
enabling automatic missing-field writes on a shared tracker.

It never merges, answers a registry-class park, re-arms a human stop or hold,
changes configuration, writes implementation code or sends free text to a
session. The tick rechecks current facts and counts retries against the
existing recovery budget. A cause re-armed three times in a week reaches the
reflection store as a proposal for a deterministic rule.

## Enable it

In the owner host's `~/.jig/dispatch.yaml`, enable `steward.enabled` and add
`steward` to the repository's stages:

```yaml
steward:
  enabled: true
repositories:
  - path: /path/to/repository
    owner: true
    stages: [rearm, pickup, followup, notify, steward]
```

Keep the repository's other machine-file settings when adding these fields.
A pass starts when the repository's judgment backlog holds work no earlier
pass judged: a stalled pickup or failed follow-up with no running session, a
stopped drive a re-arm could resolve, an ended pass recommending a resume, a
queued item missing a facet, a need nothing has framed yet, or a run that
ended without a report. An empty or
already judged backlog starts no pass, and the receipt and the dashboard say
which. The host starts at most three steward passes an hour across its
repositories, under account and host-load admission. It uses the complex tier's model of
the admitted account's vendor and has a 15-minute deadline. It starts no
interactive session. Digests and submitted records stay in the owner host's
state database; other hosts see resulting launches through the usual claims.

A pass confirms submission even when it proposes no records. An ended pass
that submitted nothing keeps a bounded output tail as untrusted diagnostic
data, and the outcome log names a recognized cause or says it is unknown.
An exit code of zero alone does not count as a submission.

Read the receipt for the steward's launch or why it waited. A person uses
[operator](../operator/SKILL.md) to give commands and
[drive-pr](../drive-pr/README.md) to drive a pull request. The steward is
started by the tick, with its launch-bound token, rather than by hand.
The [agent contract](SKILL.md) lists its record shapes and commands; the
[configuration reference](../../CONFIGURATION.md#the-machines-dispatch-file)
documents the host's settings.

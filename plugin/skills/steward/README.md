# Steward: recover routine waits and frame a person's decisions

As throughput grows, stopped work accumulates beside decisions only a person
can make. Without a steward, someone must read every log to tell a passing
failure from a decision and order assigned work whose fields leave ties.

The steward is a dispatcher-launched agent pass. It reads a digest and writes
records; the next tick checks and applies them using the dispatcher's launch
guards. It can propose another attempt for a transient stop, one fixed
resume for a routine question with a recommended option, a missing priority,
type or size, and the order of items tied under the queue's rules. Each
missing-facet proposal records the steward and its reason on the issue.
It frames the act and ask for every need that remains a person's.

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
  every: 20m
repositories:
  - path: /path/to/repository
    owner: true
    stages: [rearm, pickup, followup, notify, steward]
```

Keep the repository's other machine-file settings when adding these fields.
The host starts at most three steward passes an hour across its repositories,
only when the selected repository's input changed,
under account and host-load admission. It uses the complex tier's model of
the admitted account's vendor and has a 15-minute deadline. It starts no
interactive session. Digests and submitted records stay in the owner host's
state database; other hosts see resulting launches through the usual claims.

Read the receipt for the steward's launch or why it waited. A person uses
[operator](../operator/SKILL.md) to give commands and
[drive-pr](../drive-pr/README.md) to drive a pull request. The steward is
started by the tick, with its launch-bound token, rather than by hand.
The [agent contract](SKILL.md) lists its record shapes and commands; the
[configuration reference](../../CONFIGURATION.md#the-machines-dispatch-file)
documents the host's settings.

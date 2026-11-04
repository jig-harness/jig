# Records: what Jig's parts leave for each other

Jig's parts never share a process. A drive pass lives minutes, a dispatcher
tick seconds, and a person answers a parked question hours later. So each
part leaves records behind, and the next part reads them: a file on the
machine, a file in the working tree, a comment or a label on the pull
request, a field or a comment on the tracker. Without one list, a reader has
to trace every script to learn where a drive keeps its state, which comment
the dispatcher reads, or what stops two writers from overwriting each other.

This page lists every record the plugin keeps, **by record**: where it
lives, its format, who writes it and what guards it. It is a view
of the same system: the
[lifecycle map](https://github.com/jig-harness/jig/blob/main/docs/LIFECYCLE.md)
walks it by stage,
[FACTORY.md](https://github.com/jig-harness/jig/blob/main/FACTORY.md) by
station, and [MECHANISMS.md](MECHANISMS.md) by mechanism. Why the parts
share records rather than talk to a resident daemon is
[ADR-0013](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0013-records-not-a-daemon.md).

Contents: [the registry and the envelope](#the-registry-and-the-envelope) ·
[on the machine](#on-the-machine) ·
[in the working tree](#in-the-working-tree) ·
[on the forge and the tracker](#on-the-forge-and-the-tracker) ·
[markers that are not records](#markers-that-are-not-records)

## The registry and the envelope

Every record below is registered in the
[records registry](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`shared/records/registry.ts`) under the name in its first column, with its
medium, its owner, where it lives and its schema version. Jig's own gates
fail a hidden marker, a drive state family or a SQLite table that the
plugin's code names and the registry does not hold, and a registry entry the
code no longer names. This text check does not discover arbitrary file-backed
records or names assembled at runtime. Adding or changing those records
requires updating this inventory and the registry during review.

A record that carries the
[record envelope](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`shared/records/envelope.ts`) says what it is in the same fields
everywhere: its `kind`, its schema version `v`, its `key`, its `writer` (the
login where known, the host, the boot, the process) and the time `at`, with a
`generation` when it is rewritten in place. One codec writes it as a file's
JSON and places the same bytes in a hidden comment on the forge. On the
forge and the tracker the writer's host and boot are digests, so a public
comment names no machine. A reader checks the envelope against a strict
form and returns a failure as a value; the rest of the record is data,
never a command. The drive ledger and the follow-up marker carry it; the
other records adopt it one family at a time
([design/records.md](https://github.com/jig-harness/jig/blob/main/design/records.md)).

**How paths are written.** A path in the plugin is written from the plugin
directory (`dispatch/lib/walls.ts`), as in [MECHANISMS.md](MECHANISMS.md).
`<state dir>` is a drive's per-clone state directory,
`~/.local/state/jig/drive-pr/<clone>/`, which
`skills/drive-pr/scripts/lib/state/store.ts` resolves (`$DRIVE_PR_STATE_DIR`
moves its root). `<dispatch>` is the dispatcher's,
`~/.local/state/jig/dispatch/` (`dispatch/receipts.ts`). `<git dir>` is the
working tree's own Git directory. `~/.jig/` is `$JIG_HOME` when it is set.

## On the machine

Records only this machine reads, under the user's home or the temporary
directory.

| Record | Where it lives | Format | Written by | What guards it |
|--------|----------------|--------|------------|----------------|
| `drive-state` | `<state dir>/drive-pr-<PR>.json` | JSON with no version field; a shape the store cannot use is refused (`isUsableState`) | `skills/drive-pr/scripts/lib/state/store.ts`, through `drive-state.ts` | the state lock (a directory created atomically, `lib/state/lock.ts`); a temporary file renamed over it; the lease fence checked inside the lock |
| `drive-pr-lease` | `<state dir>/pr-drive-lease-<PR>-wt-<16 hex>.json` | JSON: holder, process, host, worktree, a generation per renewal | `skills/drive-pr/scripts/lib/state/lease-admission.ts` | a lock on the lease's path, then a renamed write |
| `drive-tree-lease` | `<state dir>/drive-tree-lease-wt-<16 hex>.json` | JSON, a fresh token on every write | `skills/drive-pr/scripts/lib/state/lease-tree.ts` | its own lock; a rollback compares the token |
| `drive-remote-lock` | `<state dir>/drive-pr-remote-lock-<PR>.lock/` | a directory lock | `skills/drive-pr/scripts/lib/state/lease-files.ts` | created atomically; a stale holder is broken by `lib/state/lock.ts`'s rules |
| `drive-pr-lock`, `drive-worktree-lock` | `<state dir>/pr-drive-<PR>.lock/` and `pr-drive-worktree-<16 hex>.lock/`, each holding a `claim.<nonce>` | a directory; the claim names the process, host and platform, then its details as JSON | `skills/drive-pr/scripts/lib/driver/locks.ts` (the claim's format: `lib/claim.ts`) | staged under another name and renamed into place: one driver per pull request and per worktree; the worktree lock is taken first |
| `drive-stop-completion` | `<state dir>/drive-pr-<PR>.stop-complete.<24 hex>.json` | JSON | `skills/drive-pr/scripts/lib/stop-request.ts` | created exclusively, then renamed; addressed by the stop's nonce |
| `drive-log` | `<state dir>/drive-pr-<PR>.log`, rotated to `.log.1` | text lines | `skills/drive-pr/scripts/lib/driver-log.ts` | appended; only the driver that holds the lock rotates it |
| `drive-ready-claim`, `drive-held-claim` | `<state dir>/drive-pr-<PR>.ready-claim`, `drive-pr-<PR>.held-claim.<key>.<16 hex>` | a token | `skills/drive-pr/scripts/lib/state/claims.ts` | created exclusively; a stale claim is broken under the state lock; released by a rename |
| `drive-pass-handoff` | `<state dir>/drive-pr-<PR>.answers.json`, `drive-pr-<PR>.notice.md` | JSON; Markdown | `skills/drive-pr/scripts/lib/state/pass-handoff.ts` | renamed into place |
| `drive-orphan-marker` | `<state dir>/.drive-pr-<PR>.orphan-warned` | empty, then one line | `skills/drive-pr/scripts/lib/state/orphans.ts` | created exclusively |
| `drive-ledger-driver` | `<state dir>/ledger-driver-<PR>.json` | JSON: the driver's worktree, start, process and host | `skills/drive-pr/scripts/lib/ledger-stop.ts` | renamed into place; removed only while it names the same start |
| `drive-report-memory` | `<state dir>/drives-report.json` | JSON: when the last morning report ran | `skills/drive-pr/scripts/lib/morning-report.ts` (`drives.ts --report`) | one writer, no lock |
| `drive-reaper-snapshot`, `drive-reaper-lock` | `<state dir>/.reap-state-snapshot.json`, `.reap-state-delete.lock/` | JSON; a directory lock | `skills/drive-pr/scripts/reap-state.ts` | the snapshot is written under the delete lock |
| `drive-legacy-migration` | `<state dir>/.migrated-from-legacy` | an empty file | `skills/drive-pr/scripts/lib/state/legacy-state.ts` | written once the old location's files have moved |
| `drive-arm-output` | `<state dir>/drive-arm-<PR>.out` | output text | nothing in this version; `skills/drive-pr/scripts/lib/state/state-file-patterns.ts` recognises it so the reaper retires one | none |
| `drive-clone-id` | `<git common dir>/drive-pr-clone-id` | a random id | `skills/drive-pr/scripts/lib/state/clone-key.ts` | created exclusively from a synced temporary file; a second writer adopts the first one's id |
| `dispatch-launch`, `dispatch-thread-sample`, `dispatch-waiting-episode`, `dispatch-notice`, `dispatch-nudge`, `dispatch-followup-outcome`, `dispatch-idle`, `dispatch-hold`, `dispatch-outcome`, `dispatch-log-cursor`, `dispatch-tick-line` | `<dispatch>/state.sqlite`, one table each: `launches`, `thread_samples`, `waiting_episodes`, `notices`, `nudges`, `followup_outcomes`, `idle`, `holds`, `log`, `log_export`, `tick_line` | SQLite, with a write-ahead log so a reader never waits on a writer; its schema version in `PRAGMA user_version`, a newer one refused | the tick, through `dispatch/lib/state.ts` and each table's module; the wrapper `dispatch/run.ts` claims a launch and records its exit; `jig dispatch result` records a session's answer | ticks run one at a time under the tick lock, each write a transaction; a launch's claim, exit and result are each written once, by an update that fills an empty column |
| `dispatch-receipt` | `<dispatch>/receipts/<date>/<run id>.json` | JSON, `version: 1` | `dispatch/receipts.ts` | created exclusively, synced and renamed; one per tick |
| `dispatch-tick-lock` | `<dispatch>/tick.lock`, `<dispatch>/tick-index` | a process id; a counter | `dispatch/receipts.ts` | the lock is published by a link, which fails while one exists; the counter is written under it |
| `dispatch-wall` | `<dispatch>/walls/<account>/<ms>-<8 hex>.json` | JSON | `dispatch/lib/walls.ts`, from `dispatch/run.ts` and `dispatch/lib/session-walls.ts` | one file per write; the wall is the latest reset of them all, so no write moves it earlier |
| `dispatch-outcome-log` | `<dispatch>/log-<year>-<month>.jsonl` | JSONL, the text copy of the `log` table | `dispatch/lib/log-export.ts` | rewritten through an exclusive temporary file and a rename, rows deduplicated by key; its cursor is the `log_export` table |
| `dispatch-workspace-note` | the session runtime's workspace name and comment (with Orca, the workspace's comment) | text: the dispatched mark, and each notification's key line | `dispatch/lib/runtime/orca-comment.ts`, for notices `dispatch/lib/actions/notify.ts` | the card lock (`shared/orca-card-lock.ts`); a notification counts as sent once its key line reads back |
| `gc-receipt` | `~/.local/state/jig/gc/<date>/<run id>.json` | JSON, `version: 1` | `gc/receipts.ts` | published by a link that never replaces; updates renamed into place |
| `gc-admission` | `~/.local/state/jig/gc-locks/<kind>/writer`, `reader-<pid>-<id>` | token files | `shared/gc-lock.ts` | created exclusively; a reader publishes before it checks and the writer before it enumerates; a lock is never taken over |
| `gc-scratch-owner` | `<scratch folder>/.jig-scratch-owner.json` | JSON, `version: 1` | `shared/scratch-owner.ts` | created exclusively |
| `gc-machine-entry` | the `gc` section of `~/.jig/jig.yaml` | YAML | `gc/install.ts` | the install lock; renamed into place |
| `scheduled-job` | a systemd user timer, a launchd job or a crontab line per component, and its launcher copy under `~/.local/state/jig/<component>/launcher/` | scheduler files | `runtime/scheduler.ts` | the install lock; staged and renamed |
| `path-command` | `~/.local/bin/jig`, and its launcher copy under `~/.local/state/jig/launcher/` | a script carrying the line `jig: written by jig install` | `runtime/path-command.ts` | a file without that line is never replaced |
| `evidence-record` | `~/.local/state/jig/evidence/<repo>/<tree>/<command>/<run id>.json` | JSON, `schema: jig-evidence/v1` | `shared/evidence.ts` | the run id is reserved by an exclusive log file; the record is renamed into place |
| `verification-fit-log` | `~/.local/state/jig/verification-fit.jsonl` | JSONL, `v: 1` | `skills/drive-pr/scripts/verification-fit.ts` | appended |
| `trace` | `~/.local/state/jig/traces/<date>/<trace id>.jsonl`, when tracing is on | JSONL | `shared/trace.ts` | appended |
| `orca-card-lock` | `~/.local/state/jig/orca-card-locks/` | a lock file | `shared/orca-card-lock.ts` | published whole by a link; a dead holder is reclaimed in generations |
| `orca-run-tab` | `~/.local/state/jig/orca-tabs/<handle>.json` | JSON, `version: 1` | `shared/orca-tabs.ts` | renamed into place |
| `orca-board-card` | the session runtime's card for a workspace: its column and comment | text | `shared/orca-board.ts` | the card lock |
| `gh-cache` | `~/.cache/jig/gh-cache/<hash>.json` | JSON, `v: 1` | `shared/gh-cache-storage.ts` | renamed into place; best effort, pruned |
| `process-registry` | `<tmp>/jig-processes-<id>/` | JSON per process | `shared/process-registry.ts` | renamed into place; a completion is published once |
| `resource-lock` | `<tmp>/jig-lock.<name>` | a link naming the holder's process | `shared/resource-lock.ts` | created atomically; a dead holder is reclaimed through a claim file |
| `turn-budget-state` | `<tmp>/jig-turn-budget/<session>/state.json` | JSON | `hooks/turn-budget-guard.ts` | renamed into place |
| `reflection-pending` | `~/.jig/pending/<repo>-<hash>/<time>-<16 hex>.jsonl` | JSONL, `v: 1` | `skills/reflect/scripts/lib/journal.ts`, also when `jig gc` removes a worktree | written whole and renamed; adopted by renaming a claim |
| `reflection-file-store` | `~/.jig/reflections/<year>-<month>/` | JSONL, `v: 1` | `skills/reflect/scripts/filesystem-store.ts` | linked into place; never replaced or edited |
| `reflection-notion-cache` | `~/.jig/cache/notion/<database>.json` | JSON | `skills/reflect/scripts/lib/notion/store.ts` | renamed into place |
| `fleet-health-snapshot` | `<fleet_health.snapshot_dir>/fleet-health.json` | JSON, `version: 1` | outside Jig: the repository's own dashboard; read by `skills/drive-pr/scripts/lib/fleet-health-advisory.ts` | none on Jig's side |

## In the working tree

Records in the clone a session works in: under `.context/`, in its Git
directory, or committed.

| Record | Where it lives | Format | Written by | What guards it |
|--------|----------------|--------|------------|----------------|
| `drive-handoff` | `.context/pr-drive-<PR>.md` | Markdown: a block opening `<!-- machine block: … -->` regenerated from the state, and a narrative under `<!-- narrative below this line is agent-authored and preserved -->` | `skills/drive-pr/scripts/lib/state/handoff.ts` | rendered in the same hold of the state lock as the state it shows; renamed into place; the narrative is kept across regenerations |
| `drive-mailbox` | `.context/drive-mailbox/inbox.jsonl`, `outbox.jsonl` | JSONL | any sender appends to the inbox through `skills/drive-pr/scripts/mailbox.ts`; only the driver appends to the outbox (`lib/state/mailbox.ts`) | append-only, each append under the file's own lock |
| `intent-chain` | `.context/intent-chain/<stem>.md` and `.current`, `pickups/<hash>.json`, and the pull request's pin `pr.<PR>.md` | Markdown opening `<!-- refocus-arm: on -->` or `off`; pickups as JSON | `skills/do-item/scripts/intent-chain.ts` and `lib/intent-chain-pickup.ts`; the pin `skills/drive-pr/scripts/capture-intent-chain.ts` | a file lock per chain; a new file published by a link that fails while one exists; a pickup never changes once written |
| `foreground-wait` | `.context/foreground-wait/gen-<n>/` | process ids, a log, a result | `skills/drive-pr/scripts/foreground-wait.ts` | creating the next generation's folder is the claim; the result is renamed into place |
| `red-team-run` | `.context/red-team/<slug>/` | the plan as JSON, and each persona's brief, reply and findings | `skills/red-team/scripts/lib/plan.ts` | one run per folder; a new run replaces it |
| `audit-record` | `.config/jig-audit.yaml`, committed | YAML | `skills/audit/scripts/record.ts` | a person commits it; `record.ts check` and Jig's audit-fit gate read it |
| `driven-tree` | `<git dir>/jig-driven-pr.json` | JSON: the pull request and branch the worktree drives | `shared/driven-tree.ts`, from `skills/drive-pr/scripts/lib/attach.ts` | renamed into place |
| `review-round-counter` | `<git dir>/resolve-review-rounds-<PR>`, and `.head` | a number; a commit | `skills/resolve-review-comments/scripts/await-round.ts` | one session per worktree, no lock |
| `reflection-journal` | `<git dir>/jig/reflection-journal.jsonl` | JSONL, `v: 1` | `skills/reflect/scripts/lib/journal.ts` | append-only |
| `conflict-snapshot` | `<git dir>/jig/conflicts.json`, and `jig/pending/` | JSON, `version: 1` | `skills/resolve-conflicts/scripts/lib/snapshot.ts` | renamed into place |
| `conflict-events` | `<git common dir>/jig/conflict-events.jsonl` | JSONL | `skills/resolve-conflicts/scripts/lib/events.ts` | appended, deduplicated by key |

## On the forge and the tracker

Records everyone who can read the repository reads: comments, the pull
request's body and labels on the forge (GitHub today), and fields, issues
and comments on the tracker. Where a row says "trusted authors only", a
script counts the record only when Jig's own login, or an owner, member or
collaborator of the repository, wrote it (`shared/trusted-authors.ts`).

| Record | Where it lives | Format | Written by | What guards it |
|--------|----------------|--------|------------|----------------|
| `drive-ledger` | one comment on the pull request opening `<!-- drive-pr-ledger -->`, its data in `<!-- drive-pr-ledger-data … -->` | a summary a person reads, then JSON carrying the record envelope (`v: 1`) beside `ledgerVersion: 1`; a ledger written before the envelope still reads | the driver: `skills/drive-pr/scripts/lib/state/ledger-mirror.ts`, through `ledger-forge.ts` | trusted authors only; the lowest trusted comment id is canonical; each write rereads the comments just before it patches and reads the ledger back after |
| `drive-takeover-claim` | a comment per claim, `<!-- drive-pr-takeover-claim -->` with `<!-- drive-pr-takeover-claim-data … -->` | JSON: actor, clone, the ledger generation it read, time | `skills/drive-pr/scripts/lib/state/ledger-forge.ts` (`postClaim`) | append-only; per ledger generation the earliest trusted claim wins |
| `dispatch-followup` | a comment on the merged pull request opening `<!-- jig-dispatch-followup -->`, its record in `<!-- jig-dispatch-followup-data … -->` from the second line | JSON carrying the record envelope (`v: 1`), then a line a person reads; a marker in the line form written before the envelope still reads | the tick (`dispatch/lib/actions/followup.ts`) or `jig dispatch marker` (`dispatch/marker.ts`), through `dispatch/lib/followup-marker.ts` | trusted authors only; the earlier comment wins; read back after posting, and checked again before each act outside the pull request |
| `drive-merge-ready` | a comment ending `<!-- drive-pr-merge-ready: <sha> -->` | Markdown | `skills/drive-pr/scripts/announce-merge-ready.ts` | one per verified head: earlier trusted announcements are swept first; the lease fence |
| `summary-answer` | a comment answering a summary finding, one `<!-- drive-pr-addressed: <fingerprint> -->` per finding | Markdown | `skills/drive-pr/scripts/answer-summary-finding.ts` | the lease fence and the held claim; a finding already answered is not answered again; read from trusted authors only |
| `thread-reply` | a reply on a review thread opening with its outcome; its last line may be `<!-- triage-thread:leave-open -->`, `<!-- reply-to-thread:no-outcome -->`, `<!-- reply-to-thread:provisional -->` or the repository's `reply.marker` | Markdown | `skills/resolve-review-comments/scripts/reply-to-thread.ts` | a marker counts only as the last line; the leave-open and provisional markers only from the scripts allowed to write them; a marker does not prove its author (`shared/reply-markers.ts`) |
| `deferred-section` | the pull request's body between `<!-- jig-deferred -->` and `<!-- /jig-deferred -->`, one `<!-- deferred-entry: … -->` block per finding | Markdown | `skills/resolve-review-comments/scripts/lib/pr-body.ts`, from `defer-in-pr.ts` and `file-deferred.ts` | the body is reread before each write, up to 3 tries, and read back after; a person's text outside the markers is never touched |
| `scanner-finding-reply` | a comment answering a scanner's finding, one `<!-- scanner-finding: <fingerprint> -->` per finding | Markdown | the session `skills/resolve-review-comments/SKILL.md` instructs; no script | an existing comment for the finding is reused |
| `ci-hold-label` | the label `ci.hold_label` names, on the pull request | a label | `skills/drive-pr/scripts/ci-hold.ts` | the label's own timeline event proves the drive made the change it undoes |
| `dispatch-state-label` | a state label on the pull request (`jig:driving`, `jig:parked`, …) where a repository turns dispatch labels on | labels | `dispatch/lib/actions/labels.ts` | derived from the ledger every tick; never read to decide what to start |
| `tracker-claim` | an item's assignee and its in-progress state | tracker fields | `skills/do-item/scripts/lib/claim.ts`, through each tracker adapter | refuses an item someone else holds; assigns first, then rereads and stands down on a race (exit 4) |
| `deferred-issue` | an issue whose description names the deferred finding | Markdown | `skills/resolve-review-comments/scripts/file-deferred.ts` | an issue that already names the finding is reused |
| `deferred-batch` | a batch issue whose description opens with `<!-- defer-batch-key: … -->` | Markdown | `skills/resolve-review-comments/scripts/defer-batch.ts` | the oldest duplicate wins; the tracker is queried again after a create |
| `tracker-related` | a comment on a GitHub issue, `<!-- jig:related <owner>/<repo>#<n> -->` | Markdown | `skills/do-item/scripts/lib/tracker/github/tracker.ts` | existing relations are checked first; read from trusted authors only |
| `reflection-github-store` | an issue per change in the reflection repository, `<!-- jig-reflection-change: <key> -->`, with comments opening `<!-- jig-reflection-events -->` | Markdown holding JSON events, `v: 1` | `skills/reflect/scripts/lib/github/store.ts` | comments are only added; trusted authors only; a change's oldest issue wins |
| `reflection-escalation` | an issue labelled with the finding's class, its owner on one line of its description | Markdown | `skills/reflect/scripts/lib/escalation.ts` | attaches only to an issue that carries the owner's line |
| `fleet-health-suspicion` | a comment on an epic ending `<!-- fleet-health: suspected kind=<kind> -->` | Markdown | `skills/drive-pr/scripts/fleet-health.ts` (`--post`) | the epic's comments are reread before it posts |
| `ai-review-summary` | the AI reviewer's sticky comment, `<!-- ai-code-review -->`, and the reviewed commit marked in it | Markdown | outside Jig: the repository's AI reviewer; read by `skills/drive-pr/scripts/lib/overlay.ts` | the markers are configuration (`review.sticky_marker`, `review.reviewed_sha_marker`) |
| `ai-review-round` | `<!-- ai-review-round: <n> -->` and `<!-- ai-review-backlog: … -->` in the reviewer's comments | Markdown | outside Jig: the repository's AI reviewer; read by `skills/drive-pr/scripts/summary-findings.ts` | none on Jig's side |
| `coderabbit-comment` | `<!-- coderabbit-ai-generated:v1 -->` and `<!-- coderabbit-skip-review-comment-follow-up -->` in CodeRabbit's comments | Markdown | outside Jig: CodeRabbit; read by `skills/drive-pr/scripts/lib/bot-confirmation.ts` | none on Jig's side |
| `epic-acceptance-verdict` | a line `<!-- epic-acceptance-verdict: … -->` in a comment on an epic | Markdown | outside Jig: a person accepting the epic; read by `skills/drive-pr/scripts/lib/fleet-health-sources.ts` | trusted authors only |

## Markers that are not records

A few hidden-marker literals in the plugin are not records, and the registry
lists them as such: the `<!-- deferral-ok: … -->` waiver a person writes in a
document, which the docs skill's deferral check reads, and the banners the
change-areas and docs skills write at the top of a file they generate.

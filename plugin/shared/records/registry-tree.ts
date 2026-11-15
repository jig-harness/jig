/**
 * The records registry's kinds in the working tree (`registry.ts`): files
 * under its root, mostly in `.context/`, and in its git directory.
 */
import { plain, type RecordKind } from "./registry-kind.ts";

const DRIVE = "skills/drive-pr/scripts/";
const STATE = `${DRIVE}lib/state/`;
const REFLECT = "skills/reflect/scripts/";

export const TREE: RecordKind[] = [
  {
    name: "drive-handoff",
    medium: "tree",
    owner: `${STATE}handoff.ts`,
    at: ".context/pr-drive-<PR>.md",
    markers: [
      "machine block",
      "narrative below this line is agent-authored and preserved",
    ],
    version: 0,
    meaning:
      "A pull request's handoff file: the machine block, regenerated with each write of the drive's state, and the narrative agents add below its marker. A successor session reads it to resume the drive without working it all out again.",
  },
  plain(
    "tree",
    "drive-mailbox",
    `${STATE}mailbox.ts`,
    ".context/drive-mailbox/inbox.jsonl, outbox.jsonl",
    0,
    "The one way to steer or stop a running drive: a person, a session or a tool appends a message to the inbox, and the drive answers and acknowledges in the outbox.",
  ),
  {
    name: "intent-chain",
    medium: "tree",
    owner: "skills/do-item/scripts/intent-chain.ts",
    at: ".context/intent-chain/<stem>.md, pickups/<hash>.json, pr.<PR>.md",
    markers: ["refocus-arm"],
    version: 0,
    meaning:
      "The tracker item a pickup works and the items above it, as the pickup fetched them, which keeps an agent's work tied to why it exists; its first line names the calibration arm the hook and the drive read.",
  },
  plain(
    "tree",
    "foreground-wait",
    `${DRIVE}foreground-wait.ts`,
    ".context/foreground-wait/gen-<n>/",
    0,
    "A long step a driver pass launched once and waits on across several tool calls: the folder of the next generation is the claim, and the step's result is renamed into place.",
  ),
  plain(
    "tree",
    "red-team-run",
    "skills/red-team/scripts/lib/plan.ts",
    ".context/red-team/<slug>/plan.json and each persona's files",
    0,
    "A red-team review's plan, and each persona's brief and findings, which every later step of the review reads.",
  ),
  plain(
    "tree",
    "audit-record",
    "skills/audit/scripts/record.ts",
    ".config/jig-audit.yaml",
    0,
    "The repository's committed audit: each criterion scored with its evidence, and the team's decisions, against which a new audit is compared.",
  ),
  plain(
    "tree",
    "facet-move-record",
    "skills/file-issue/scripts/lib/move-record.ts",
    "the file `check-fields.ts move --record` names (`.context/facet-move/record.json` in file-issue's procedure)",
    1,
    "A move of the tracker's facets from one store to another: each change added before its write and marked once it lands, so `--restore` can put every value back as it was.",
  ),
  plain(
    "tree",
    "issue-fields-position",
    "skills/file-issue/scripts/lib/sweep-position.ts",
    "the file `check-fields.ts check --position` names, kept by the scheduler between runs",
    1,
    "Where the issue-fields sweep left off, so the next run resumes after it; a missing or unreadable file starts again from the oldest issue.",
  ),
  plain(
    "tree",
    "driven-tree",
    "shared/driven-tree.ts",
    "<git dir>/jig-driven-pr.json",
    0,
    "The pull request, branch and remote a drive attached this working tree to, which every script that starts from a tree on a detached head reads.",
  ),
  plain(
    "tree",
    "reflection-journal",
    `${REFLECT}lib/journal.ts`,
    "<git dir>/jig/reflection-journal.jsonl",
    1,
    "The worktree's journal of findings captured as they happen, before `reflect` sends them to the store; lines are only appended.",
  ),
  plain(
    "tree",
    "conflict-snapshot",
    "skills/resolve-conflicts/scripts/lib/snapshot.ts",
    "<git dir>/jig/conflicts.json, jig/pending/<kind>-<head>-<incoming>.json",
    1,
    "The map of a stopped merge's conflicts, with each side's version and the resolver's record, so the check after resolution compares each resolved file with both sides.",
  ),
  plain(
    "tree",
    "conflict-events",
    "skills/resolve-conflicts/scripts/lib/events.ts",
    "<git common dir>/jig/conflict-events.jsonl",
    0,
    "One event per conflicted path a merge, rebase or cherry-pick resolved, shared by every worktree of the clone, from which the history of where merges conflicted is reported.",
  ),
];

/** Follow-up progress is a tick fact, separate from the PR's forge state. */
import type {
  LineSnapshot,
  QueueGroup,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { sessionKind, type SessionKind } from "./view.ts";

const QUEUED = {
  starts: "Awaiting follow-up",
  held: "Awaiting follow-up",
  reported: "Follow-up not scheduled",
  never: "Follow-up blocked",
};
const RUNNING: Record<SessionKind, string> = {
  working: "Follow-up running",
  takeover: "Follow-up running",
  pending: "Follow-up starting",
  stuck: "Follow-up needs attention",
  waitWall: "Follow-up waiting",
  waitOther: "Follow-up waiting",
  drift: "Follow-up stalled",
  unknown: "Follow-up state unknown",
};

export function queuedFollowup(group: QueueGroup): string {
  return QUEUED[group];
}
export function runningFollowup(kind: SessionKind): string {
  return RUNNING[kind];
}

/** One PR counts once: an attention record or active session takes precedence over its queue entry. */
export function followupCounts(
  line: LineSnapshot,
  nowMs: number,
): Record<string, number> {
  const work = new Map<string, string>();
  for (const n of line.needs) {
    if (n.stage === "followup")
      work.set(`${n.repo}#${n.pr}`, "Follow-up needs attention");
  }
  for (const s of line.sessions) {
    if (s.stage !== "followup") continue;
    const key = `${s.repo}#${s.pr}`;
    if (!work.has(key)) work.set(key, runningFollowup(sessionKind(s, nowMs)));
  }
  for (const q of line.queue) {
    if (q.source !== "merged") continue;
    const key = `${q.repo}#${q.pr}`;
    if (!work.has(key)) work.set(key, queuedFollowup(q.group));
  }
  const counts: Record<string, number> = {};
  for (const status of work.values())
    counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

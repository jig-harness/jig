/** The work's workspace from records the tick already read, independent of where it sent a notice. */
import { holds, type ReadRecord, targetOf } from "./launches.ts";
import {
  NOTICES_BRANCH,
  NOTICES_NAME,
  type SessionsReport,
} from "./runtime/port.ts";
import type { Action, RepoReport } from "./types.ts";

function unique(paths: string[]): string | null {
  if (paths.some((p) => p === "")) return null;
  const known = [...new Set(paths)];
  return known.length === 1 ? (known[0] ?? null) : null;
}

/** An explicit stage record wins; otherwise reconcile holding records and joined workspaces without hiding ambiguous claims. */
export function needWorkspace(
  report: RepoReport,
  target: string,
  stage: string,
  sessions: SessionsReport | undefined,
  records: ReadRecord[],
  action?: Action,
): string | null {
  if (action?.workspace) return action.workspace;
  const matching = records.filter(
    ({ record }) =>
      record.repo === report.slug &&
      record.repoPath === report.path &&
      targetOf(record) === target &&
      (stage === "steer" ||
        record.action === stage ||
        (stage === "rearm" && record.action === "takeover")),
  );
  const named = matching.find(
    ({ record }) => record.id === action?.evidence.record,
  );
  if (named?.record.workspace) return named.record.workspace.path;
  const holding = matching.filter((r) => holds(r.state));
  if (holding.some((r) => !r.record.workspace?.path)) return null;
  const paths = holding.flatMap((r) =>
    r.record.workspace ? [r.record.workspace.path] : [],
  );
  if (sessions?.ok !== true) return unique(paths);
  const pr = /^PR #(\d+)$/.exec(target);
  const joined = sessions.workspaces.filter(
    (w) =>
      w.name !== NOTICES_NAME &&
      !w.comment.split("\n").some((line) => line.trim() === NOTICES_NAME) &&
      w.branch !== NOTICES_BRANCH &&
      w.branch !== report.section?.noticesBranch &&
      (pr === null ? w.items.includes(target) : w.prs.includes(Number(pr[1]))),
  );
  return unique([...paths, ...joined.map((w) => w.path)]);
}

/** The work's workspace from records the tick already read, independent of where it sent a notice. */
import { holds, type ReadRecord, targetOf } from "./launches.ts";
import { NOTICES_NAME, type SessionsReport } from "./runtime/port.ts";
import type { Action, RepoReport } from "./types.ts";

function unique(paths: string[]): string | null {
  const known = [...new Set(paths.filter((p) => p !== ""))];
  return known.length === 1 ? (known[0] ?? null) : null;
}

/** An explicit stage record wins; otherwise a single holding session or joined workspace supplies the path. Ambiguity stays unknown. */
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
  const holding = matching.filter(
    (r) => holds(r.state) && r.record.workspace !== null,
  );
  if (holding.length > 0)
    return unique(
      holding.flatMap((r) =>
        r.record.workspace ? [r.record.workspace.path] : [],
      ),
    );
  if (sessions?.ok !== true) return null;
  const pr = /^PR #(\d+)$/.exec(target);
  const joined = sessions.workspaces.filter(
    (w) =>
      w.name !== NOTICES_NAME &&
      !w.comment.split("\n").some((line) => line.trim() === NOTICES_NAME) &&
      w.branch !== report.section?.noticesBranch &&
      (pr === null ? w.items.includes(target) : w.prs.includes(Number(pr[1]))),
  );
  const running = joined.filter((w) => w.agents.length > 0);
  return unique((running.length > 0 ? running : joined).map((w) => w.path));
}

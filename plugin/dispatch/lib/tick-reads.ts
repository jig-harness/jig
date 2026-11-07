/**
 * What one tick reads once and shares between its repositories' observe
 * phases: each pull request's comments (`tick-comments.ts`), the forge's
 * login, the runtime's host-wide listings, and the forge's budget. The
 * login and the listings are the host's, not a repository's: each is read
 * once, the first time a repository needs it, and every repository is
 * answered from that read, a failed one failing each repository's record as
 * a read of its own would. The budget is read once as the tick closes, so
 * every repository's report says what was left after the whole tick.
 *
 * None of these serves a read just before a launch: those go to the forge
 * and the runtime (`tick-apply.ts`).
 */
import { resolveLogin } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import type { SharedRecords } from "../../shared/records/shared.ts";
import { forgetMergeRead } from "./merge-reads.ts";
import type { SessionRuntime, SessionsReader } from "./runtime/port.ts";
import { type TickComments, tickComments } from "./tick-comments.ts";
import type { SharedReport } from "./types.ts";

/** A shared report waiting for the forge's budget, and the records it reads it through. */
export interface BudgetWanted {
  report: SharedReport;
  records: SharedRecords;
}

export interface TickReads {
  comments: TickComments;
  /** The login the forge client is signed in as, read once per tick. */
  login(): Promise<string | null>;
  /** The runtime's sessions for one repository, its host-wide listings read once per tick. */
  sessions: SessionsReader;
  /** The shared reports that want the budget, filled when the tick closes (`fillBudgets`). */
  budgets: BudgetWanted[];
}

/**
 * The runtime's sessions reader, made the first time a repository reads
 * sessions, so a runtime whose `sessionsOnce` throws fails that read inside
 * the repository's boundary rather than the tick's start.
 */
function lazySessions(runtime: SessionRuntime): SessionsReader {
  let reader: SessionsReader | null = null;
  return async (repo, join) => {
    reader ??= runtime.sessionsOnce?.() ?? ((r, j) => runtime.sessions(r, j));
    return await reader(repo, join);
  };
}

/** One tick's shared reads; a write the tick makes on a merged pull request drops its kept marker read too. */
export function tickReads(runtime: SessionRuntime): TickReads {
  let login: Promise<string | null> | null = null;
  return {
    comments: tickComments({
      written: (repo, pr) => forgetMergeRead(repo, pr),
    }),
    login: () => {
      login ??= resolveLogin();
      return login;
    },
    sessions: lazySessions(runtime),
    budgets: [],
  };
}

/** Read the forge's budget once, after every repository's reads, and put it on each report that wants it. */
export async function fillBudgets(reads: TickReads): Promise<void> {
  const [first] = reads.budgets;
  if (first === undefined) return;
  const read = await first.records.budget();
  const budget = read.ok ? read.value : { unreadable: read.failure.reason };
  for (const { report } of reads.budgets) report.budget = budget;
}

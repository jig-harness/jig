/** Why a tick failed, as its receipt records it: shared by the tick's failure ledger and `jig doctor`. */
import type { TickReceipt } from "../receipts.ts";
import type { RepoReport } from "./types.ts";

/** Why a repository's turn failed this tick; `null` when it was read whole. */
export function repoFailure(report: RepoReport): string | null {
  if (report.refused !== null) return report.refused;
  const defect = report.stageDefects?.[0];
  if (defect !== undefined) return defect.reason;
  const unread = report.records.find((r) => !r.ok);
  if (unread !== undefined)
    return `the ${unread.record} record (${unread.source}) did not read: ${unread.detail}`;
  // An individual comment listing or ledger that failed leaves the aggregate forge record ok.
  const failed = report.unplaced.find((u) => u.readFailed === true);
  return failed === undefined
    ? null
    : `${failed.target} did not read: ${failed.reason}`;
}

/** Why the tick exits 1, in one sentence. */
export function tickFailure(receipt: TickReceipt): string {
  if (receipt.defect !== undefined) return receipt.defect.reason;
  if (receipt.applyWithheld !== undefined)
    return `--apply was withheld: ${receipt.applyWithheld}`;
  const failing = receipt.repos.flatMap((r) => {
    const why = repoFailure(r);
    return why === null ? [] : [`${r.slug ?? r.path}: ${why}`];
  });
  if (failing.length > 0)
    return `${failing.length === 1 ? "a repository's turn failed" : `${failing.length} repositories' turns failed`}, ${failing[0]}${failing.length > 1 ? ` (and ${failing.length - 1} more)` : ""}`;
  const unlogged =
    receipt.unloggedOutcomes?.[0] ??
    receipt.repos
      .flatMap((r) => r.unplaced)
      .find((u) => u.target === "the outcome log")?.reason;
  if (unlogged !== undefined)
    return `the outcome log was not written: ${unlogged}`;
  if (receipt.logCopyFailed !== undefined)
    return `the outcome log's copy was not written: ${receipt.logCopyFailed}`;
  if (receipt.lineFailed !== undefined)
    return `the dashboard line was not written: ${receipt.lineFailed}`;
  return "the tick exited 1 with no cause on its receipt";
}

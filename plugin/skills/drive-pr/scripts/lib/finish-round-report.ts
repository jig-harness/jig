/** The round finisher's report shared by its emitters. */
type ItemAction = "resolved" | "left-open" | "answered" | "refused";

export interface ItemResult {
  key: string;
  kind: string;
  action: ItemAction;
  /** The refusing script's exit code; 0 on success. */
  code: number;
  /**
   * That script's own stderr, verbatim — never re-worded here. The one
   * exception: an item that exhausted the retry/read bounds without ever
   * being dispatched has no script's stderr to carry, so its diagnostic is
   * synthesized instead (see the post-drain verification block).
   */
  diagnostic?: string;
}

export interface Report {
  pr: number;
  head: string;
  state:
    | "FINISHED"
    | "REFUSED_UNCLEAN"
    | "REFUSED_UNTRIAGED"
    | "REFUSED_COMMIT_PREFIX"
    | "TRIAGE_CHECK_FAILED"
    | "PR_NOT_OPEN"
    | "PUSH_FAILED"
    | "CI_HOLD_WAIT"
    | "CI_HOLD_FAILED"
    | "HITL_PARKED"
    | "STAMP_FAILED"
    | "HEAD_NOT_SYNCED"
    | "BATCH_UNREADABLE"
    | "PARTIAL"
    | "LEASE_HELD";
  reason: string;
  pushed: boolean;
  stamped: boolean;
  headSynced: boolean;
  items: ItemResult[];
}

export function emit(report: Report, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  process.stdout.write(`${report.state}: ${report.reason}\n`);
  for (const i of report.items) {
    process.stdout.write(
      `  ${i.action === "refused" ? `refused(${i.code})` : i.action} ${i.kind} ${i.key}\n`,
    );
  }
}

export function prefixLines(prefix: string, text: string): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? "" : `${prefix}${body.replaceAll("\n", `\n${prefix}`)}`;
}

/**
 * Re-print a helper's captured stderr so a human watching the run sees the
 * refusal as it happens, not only in the final report. Captured rather than
 * inherited because the report carries it too — and a diagnostic that exists
 * only in a scrollback is one an unattended pass cannot act on.
 */
export function echoDiagnostic(label: string, stderr: string): void {
  if (stderr.trim() === "") return;
  console.error(prefixLines(`  ${label}: `, stderr));
}

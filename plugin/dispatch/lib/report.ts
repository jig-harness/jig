/** A tick's receipt as the terminal reads it. */
import type { TickReceipt } from "../receipts.ts";
import type { Evidence, LaunchOutcome, RepoReport } from "./types.ts";

function evidence(e: Evidence): string {
  const parts = Object.entries(e)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length === 0 ? "" : `\n        evidence: ${parts.join(", ")}`;
}

function launchLine(l: LaunchOutcome): string {
  const on = l.account === null ? "" : ` on ${l.account}`;
  const record = l.record === null ? "" : ` (record ${l.record})`;
  return `  ${l.outcome.padEnd(8)} ${l.action} ${l.target}${on}${record}: ${l.detail}`;
}

function repoLines(r: RepoReport, apply: boolean): string[] {
  const verb = apply ? "wants" : "would";
  const lines = [`${r.slug ?? "(unknown repository)"} (${r.path})`];
  if (r.refused !== null) return [...lines, `  refused: ${r.refused}`];
  for (const x of r.records)
    lines.push(
      `  read ${x.ok ? "ok    " : "FAILED"} ${x.record.padEnd(7)} ${x.source}: ${x.detail}`,
    );
  if (r.actions.length === 0) lines.push(`  ${verb} start nothing`);
  for (const a of r.actions)
    lines.push(
      `  ${verb} ${a.stage.padEnd(8)} ${a.target}${a.cause === undefined ? "" : ` (${a.cause})`}, wanted by the ${a.record}: ${a.reason}${evidence(a.evidence)}`,
    );
  lines.push(...r.launches.map(launchLine));
  for (const x of r.running)
    lines.push(`  running  ${x.stage.padEnd(8)} ${x.target}: ${x.reason}`);
  for (const u of r.unplaced)
    lines.push(`  unplaced ${u.target} (${u.record}): ${u.reason}`);
  for (const q of r.quiet)
    lines.push(`  ${q.class.padEnd(17)} ${q.target}: ${q.why}`);
  return lines;
}

export function formatReceipt(receipt: TickReceipt, path: string): string {
  const head = receipt.apply
    ? `jig dispatch --apply: what the machine file enables was started (tick ${receipt.runId})`
    : `jig dispatch: a report; nothing was started (tick ${receipt.runId})`;
  return [
    head,
    "",
    ...(receipt.unreadableLaunches ?? []).map(
      (p) => `launch record that does not read, left out: ${p}`,
    ),
    ...receipt.repos.flatMap((r) => [...repoLines(r, receipt.apply), ""]),
    `Receipt: ${path}`,
  ].join("\n");
}

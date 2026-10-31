/** A tick's receipt as the terminal reads it. */
import type { TickReceipt } from "../receipts.ts";
import type { Evidence, RepoReport } from "./types.ts";

function evidence(e: Evidence): string {
  const parts = Object.entries(e)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length === 0 ? "" : `\n        evidence: ${parts.join(", ")}`;
}

function repoLines(r: RepoReport): string[] {
  const lines = [`${r.slug ?? "(unknown repository)"} (${r.path})`];
  if (r.refused !== null) return [...lines, `  refused: ${r.refused}`];
  for (const x of r.records)
    lines.push(
      `  read ${x.ok ? "ok    " : "FAILED"} ${x.record.padEnd(7)} ${x.source}: ${x.detail}`,
    );
  if (r.actions.length === 0) lines.push("  would start nothing");
  for (const a of r.actions)
    lines.push(
      `  would ${a.stage.padEnd(8)} ${a.target}, wanted by the ${a.record}: ${a.reason}${evidence(a.evidence)}`,
    );
  for (const x of r.running)
    lines.push(`  running  ${x.stage.padEnd(8)} ${x.target}: ${x.reason}`);
  for (const u of r.unplaced)
    lines.push(`  unplaced ${u.target} (${u.record}): ${u.reason}`);
  for (const q of r.quiet)
    lines.push(`  ${q.class.padEnd(17)} ${q.target}: ${q.why}`);
  return lines;
}

export function formatReceipt(receipt: TickReceipt, path: string): string {
  return [
    `jig dispatch: a report; nothing was started (tick ${receipt.runId})`,
    "",
    ...receipt.repos.flatMap((r) => [...repoLines(r), ""]),
    `Receipt: ${path}`,
  ].join("\n");
}

/** A tick's receipt as the terminal reads it. */
import type { TickReceipt } from "../receipts.ts";
import type { SerialReport } from "./contention.ts";
import type {
  Evidence,
  LabelReport,
  LabelWrite,
  LaunchOutcome,
  NotifyOutcome,
  RepoReport,
  RetireOutcome,
  SteerOutcome,
} from "./types.ts";

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

function noticeLine(n: NotifyOutcome): string {
  const to = n.workspace === null ? "" : ` to ${n.workspace}`;
  return `  ${n.outcome.padEnd(10)} notify ${n.target} (${n.cause})${to}: ${n.detail}`;
}

function retireLine(n: RetireOutcome): string {
  return `  ${n.outcome.padEnd(10)} notices ${n.workspace}: ${n.detail}`;
}

function steerLine(s: SteerOutcome): string {
  return `  ${s.outcome.padEnd(10)} steer  ${s.target} (record ${s.record}, wall ${s.episode}): ${s.detail}`;
}

/** What `--apply` launched, nudged and notified. */
function outcomeLines(r: RepoReport): string[] {
  // A receipt written before notifications or nudges were sent has none.
  const notified = r.notifications ?? [];
  return [
    ...r.launches.map(launchLine),
    ...(r.steers ?? []).map(steerLine),
    ...notified.map(noticeLine),
    ...(r.noticesWorkspace === undefined
      ? []
      : [retireLine(r.noticesWorkspace)]),
  ];
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
  lines.push(...outcomeLines(r));
  for (const x of r.running)
    lines.push(`  running  ${x.stage.padEnd(8)} ${x.target}: ${x.reason}`);
  for (const u of r.unplaced)
    lines.push(`  unplaced ${u.target} (${u.record}): ${u.reason}`);
  for (const q of r.quiet)
    lines.push(`  ${q.class.padEnd(17)} ${q.target}: ${q.why}`);
  lines.push(...labelLines(r.labels), ...serialLines(r.serialized));
  return lines;
}

/** Serialization's part: each group in order with its leader, why an order cannot be told, and each hold. */
function serialLines(s: SerialReport | undefined): string[] {
  if (s === undefined) return [];
  return [
    `  serial   ${s.catalog}: ${s.areas.join(", ") || "no area"} serialized`,
    ...s.groups.flatMap((g) => [
      `  serial   ${g.area}: ${
        g.leader === null
          ? `no leader (${g.unplaced ?? "order unknown"})`
          : `${g.leader} leads`
      }${g.drives === undefined ? "" : `; ${g.drives}`}`,
      ...g.order.map(
        (m, i) => `             ${i + 1}. ${m.target}: ${m.place}`,
      ),
    ]),
    ...s.held.map(
      (h) => `  held     ${h.stage.padEnd(8)} ${h.target}: ${h.reason}`,
    ),
  ];
}

/** The dispatch labels' part: the count, each command label, what a hold kept off, and each write. */
function labelLines(l: LabelReport | undefined): string[] {
  if (l === undefined) return [];
  const count = (o: LabelWrite["outcome"]) =>
    l.writes.filter((w) => w.outcome === o).length;
  const unread = l.onlyLabeled
    ? `, ${l.unlabeled} open pull request(s) with no label of the set not read`
    : "";
  return [
    `  labels   ${l.prefix} on${l.onlyLabeled ? ", only labelled pull requests" : ""}: ${l.states.length} managed, ${count("written")} relabelled, ${count("failed")} refused, ${count("would")} would be relabelled${unread}`,
    ...l.commands.map((c) => `  ${c.command.padEnd(8)} ${c.target}: ${c.note}`),
    ...l.held.map(
      (h) => `  held     ${h.stage.padEnd(8)} ${h.target}: ${h.reason}`,
    ),
    ...l.writes.map(
      (w) => `  label    ${w.outcome.padEnd(8)} ${w.target}: ${w.detail}`,
    ),
  ];
}

export function formatReceipt(receipt: TickReceipt, path: string): string {
  const head = receipt.apply
    ? `jig dispatch --apply: what the machine file enables was started (tick ${receipt.runId})`
    : `jig dispatch: a report; nothing was started (tick ${receipt.runId})`;
  return [
    head,
    "",
    ...(receipt.applyWithheld === undefined
      ? []
      : [
          `--apply withheld, nothing was started: ${receipt.applyWithheld}`,
          "",
        ]),
    ...(receipt.accountsNotAdmitted ?? []).map(
      (a) =>
        `account ${a.account} (vendor ${a.vendor}) accepted, not admitted: ${a.reason}`,
    ),
    ...(receipt.unreadableLaunches ?? []).map(
      (p) => `launch record that does not read, left out: ${p}`,
    ),
    ...(receipt.unloggedOutcomes ?? []).map(
      (reason) => `outcome log: ${reason}`,
    ),
    ...(receipt.logCopyFailed === undefined
      ? []
      : [`outcome log: ${receipt.logCopyFailed}`]),
    ...receipt.repos.flatMap((r) => [...repoLines(r, receipt.apply), ""]),
    `Receipt: ${path}`,
  ].join("\n");
}

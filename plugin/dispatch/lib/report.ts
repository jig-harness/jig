/** A tick's receipt as the terminal reads it. */
import { upgradeLine } from "../../runtime/upgrade-record.ts";
import type { TickReceipt } from "../receipts.ts";
import type { SerialReport } from "./contention.ts";
import type {
  RecurrenceFinding,
  ReflectionReport,
} from "./reflection-route.ts";
import type {
  Evidence,
  LabelReport,
  LabelWrite,
  LaunchOutcome,
  NotifyOutcome,
  PrOpenMove,
  ReleaseOutcome,
  RepoReport,
  RetireOutcome,
  SharedReport,
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

function releaseLine(r: ReleaseOutcome): string {
  return `  ${r.outcome.padEnd(8)} release ${r.target} (marker comment ${r.marker}, ${r.claimant}): ${r.detail}`;
}

/** A stalled pickup's move to `pr_open`: what `--apply` did, or what the plan wants. */
function moveLine(m: PrOpenMove, verb: string): string {
  const what = `move     ${m.target} to ${m.to} (pull request #${m.pr} from ${m.branch}, record ${m.record})`;
  return m.outcome === undefined
    ? `  ${verb} ${what}`
    : `  ${m.outcome.padEnd(8)} ${what}: ${m.detail ?? ""}`;
}

/** The moves to `pr_open` the plan wants and `--apply` did not act on. */
function plannedMoves(r: RepoReport, verb: string): string[] {
  return (r.prOpenMoves ?? [])
    .filter((m) => m.outcome === undefined)
    .map((m) => moveLine(m, verb));
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
    ...(r.releases ?? []).map(releaseLine),
    ...(r.prOpenMoves ?? [])
      .filter((m) => m.outcome !== undefined)
      .map((m) => moveLine(m, "")),
    ...(r.steers ?? []).map(steerLine),
    ...notified.map(noticeLine),
    ...(r.noticesWorkspace === undefined
      ? []
      : [retireLine(r.noticesWorkspace)]),
  ];
}

/**
 * The defects a repository's report carries: the one that stopped its turn,
 * after which what its earlier phases did is still listed, then each one a
 * stage caught, which stopped that stage only.
 */
function defectLines(r: RepoReport): string[] {
  return [
    ...(r.refused === null ? [] : [`  DEFECT   ${r.refused}`]),
    ...(r.stageDefects ?? []).map(
      (d) => `  DEFECT   ${d.stage ?? d.phase}: ${d.reason}`,
    ),
  ];
}

function repoLines(r: RepoReport, apply: boolean): string[] {
  const verb = apply ? "wants" : "would";
  const lines = [`${r.slug ?? "(unknown repository)"} (${r.path})`];
  const took = phaseLine("  took     ", r.phasesMs);
  if (r.refused !== null && r.defect === undefined)
    return [...lines, `  refused: ${r.refused}`, ...took];
  lines.push(...defectLines(r));
  for (const x of r.records)
    lines.push(
      `  read ${x.ok ? "ok    " : "FAILED"} ${x.record.padEnd(7)} ${x.source}: ${x.detail}`,
    );
  if (r.actions.length === 0) lines.push(`  ${verb} start nothing`);
  for (const a of r.actions)
    lines.push(
      `  ${verb} ${a.stage.padEnd(8)} ${a.target}${a.cause === undefined ? "" : ` (${a.cause})`}, wanted by the ${a.record}: ${a.reason}${evidence(a.evidence)}`,
    );
  lines.push(...plannedMoves(r, verb), ...outcomeLines(r));
  for (const x of r.running)
    lines.push(`  running  ${x.stage.padEnd(8)} ${x.target}: ${x.reason}`);
  for (const u of r.unplaced)
    lines.push(`  unplaced ${u.target} (${u.record}): ${u.reason}`);
  for (const q of r.quiet)
    lines.push(`  ${q.class.padEnd(17)} ${q.target}: ${q.why}`);
  lines.push(
    ...labelLines(r.labels),
    ...serialLines(r.serialized),
    ...sharedLines(r.shared),
    ...took,
  );
  return lines;
}

/** A duration as a person reads it: milliseconds below a second, else seconds to one decimal. */
export function elapsed(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Each timed phase and the time all of them took, on one line; none for a receipt written before phases were timed. */
function phaseLine(
  lead: string,
  phases: Partial<Record<string, number>> | undefined,
): string[] {
  const timed = Object.entries(phases ?? {}).filter(
    (e): e is [string, number] => typeof e[1] === "number",
  );
  if (timed.length === 0) return [];
  const total = timed.reduce((n, [, ms]) => n + ms, 0);
  return [
    `${lead}${elapsed(total)}: ${timed.map(([phase, ms]) => `${phase} ${elapsed(ms)}`).join(", ")}`,
  ];
}

/** The shared records' part: which host owns the repository, and what sharing cost this tick. */
function sharedLines(s: SharedReport | undefined): string[] {
  if (s === undefined) return [];
  const others = s.owners.length === 0 ? "" : s.owners.join(", ");
  const owner = s.owner
    ? `this host (${s.host}) owns it: its board, notifications, labels and history rows${others === "" ? "" : `; the claims of ${others} say they own it too, so set owner: false on every host but one`}`
    : `another host owns it (${others === "" ? "none seen in a claim yet" : others}); this host (${s.host}, owner: false) launches through the shared records and writes none of the owner's records`;
  const budget =
    s.budget === null
      ? ""
      : "unreadable" in s.budget
        ? `; the budget left does not read: ${s.budget.unreadable}`
        : `; ${s.budget.remaining} of ${s.budget.limit} left until ${s.budget.resetAt}`;
  return [
    `  owner    ${owner}`,
    `  shared   ${s.medium}: ${s.reads} read(s), ${s.writes} write(s)${budget}`,
  ];
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

/** The dispatch labels' part: the count, each command label, what a hold kept off, each write, and each item moved to or out of `blocked`. */
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
    ...(l.blocked ?? []).map(
      (b) => `  blocked  ${b.outcome.padEnd(8)} ${b.target}: ${b.detail}`,
    ),
  ];
}

/** The reflection route's part: each finding recorded, pending or that would be recorded, and each failure. */
function reflectionLines(r: ReflectionReport | undefined): string[] {
  if (r === undefined) return [];
  const finding = (f: RecurrenceFinding) =>
    `${f.class} on the ${f.stage} stage of ${f.repo}, ${f.week} (${f.id})`;
  return [
    ...r.recorded.map((f) => `reflection recorded ${finding(f)}`),
    ...r.pending.map(
      (f) => `reflection pending  ${finding(f)}, sent again by the next tick`,
    ),
    ...r.would.map((f) => `reflection would    record ${finding(f)}`),
    ...r.failures.map((f) => `reflection failed   ${f.repo}: ${f.reason}`),
    "",
  ];
}

export function formatReceipt(receipt: TickReceipt, path: string): string {
  const head = receipt.apply
    ? `jig dispatch --apply: what the machine file enables was started (tick ${receipt.runId})`
    : `jig dispatch: a report; nothing was started (tick ${receipt.runId})`;
  return [
    head,
    "",
    ...(receipt.upgrade === undefined
      ? []
      : [`upgrade: ${upgradeLine(receipt.upgrade)}`, ""]),
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
    ...(receipt.unanswered ?? []).map(
      (u) =>
        `${u.system} did not answer (${u.class}), so it was not asked again this tick: ${u.reason}`,
    ),
    ...receipt.repos.flatMap((r) => [...repoLines(r, receipt.apply), ""]),
    ...(receipt.defect === undefined
      ? []
      : [`DEFECT: the tick did not complete: ${receipt.defect.reason}`]),
    ...phaseLine("Tick took ", receipt.phasesMs),
    ...reflectionLines(receipt.reflection),
    `Receipt: ${path}`,
  ].join("\n");
}

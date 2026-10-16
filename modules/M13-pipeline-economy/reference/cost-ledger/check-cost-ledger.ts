#!/usr/bin/env bun
// Cost-ledger check: every decision that changed what a pipeline spends carries
// its measurement before and after and a reopen condition that can be checked.
//
// The problem it catches. A runner resized, a pre-push leg narrowed, a suite
// moved to a schedule, a cache turned on: each trades something, and a trade
// without a number is re-argued at every round. A decision recorded with
// "reopen if it gets expensive" is never reopened, because nobody can say
// when "expensive" arrived; one recorded with a metric nobody collects is
// dark. And a decision whose after-measurement was "coming" stays unmeasured
// for good unless something fails when the date passes.
//
// The rule. The ledger is a mapping with `version: 1` and a `decisions`
// list; an empty list passes as nothing to check yet, so the check can be
// wired before the first decision. Each decision carries:
//   * `id`, a kebab-case slug, unique in the ledger;
//   * `decision`, one non-empty line;
//   * `measured`: `unit`, a non-empty string; `before`, a finite number;
//     `after`, a finite number, or null together with `measure_by`, a calendar
//     date (YYYY-MM-DD) that is not before the day the check runs; and
//     optionally `windows`, the two windows the numbers come from;
//   * `reopen`, a non-empty list of conditions, each with `metric` (a
//     kebab-case id), `comparator` (one of > >= < <=), `threshold` (a finite
//     number), `window` (`30d`, `4w`, `6m`, `12h` or `100 runs`) and
//     optionally `then`, what reopening means.
// With `--metrics <registry>`, every `metric` must be an `id` in the registry's
// `metrics` list (M11's metrics-registry.yaml): a reopen condition over a
// metric the registry does not carry cannot be checked.
//
// Fail closed. The ledger unreadable, not YAML, not a mapping with a
// `decisions` list; the registry unreadable or without
// a `metrics` list; a `--now` that is not a calendar date; a bad option: each
// exits 2. Input the check could not read never passes.
//
// Exit codes: 0 every decision is complete, 1 at least one finding, 2 usage
// or input error.
//
// Usage:
//   check-cost-ledger.ts [--metrics metrics-registry.yaml] [--now YYYY-MM-DD] ci-cost-ledger.yaml
import { cli, optionValue } from "../../../../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import { readYaml } from "../../../../lib/workflows.ts";

const GATE = "cost-ledger";
const usage =
  "usage: check-cost-ledger.ts [--metrics <registry.yaml>] [--now <YYYY-MM-DD>] <ledger.yaml>";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMPARATORS = new Set([">", ">=", "<", "<="]);
const WINDOW = /^[1-9][0-9]*(?:[dwmh]| runs)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A finding before its file and line are known. */
export type LedgerFinding = Omit<Finding, "file" | "line"> & { id?: string };

/**
 * The day in milliseconds; throw unless it is a real calendar date. A YAML
 * loader reads an unquoted `2026-01-01` as a timestamp at midnight UTC, so
 * that form is accepted as the same day; a timestamp with a time of day is
 * not a calendar date.
 */
export function parseDate(value: unknown, what: string): number {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const ms = value.getTime();
    if (ms % 86_400_000 === 0) return ms;
  }
  const f = typeof value === "string" ? DATE.exec(value) : null;
  if (f !== null) {
    const ms = Date.UTC(Number(f[1]), Number(f[2]) - 1, Number(f[3]));
    // Date.UTC rolls an impossible day over into the next month, so a real
    // date is one that comes back unchanged.
    if (new Date(ms).toISOString().startsWith(f[0])) return ms;
  }
  throw new Error(
    `${what} is not a calendar date (YYYY-MM-DD): ${String(value)}`,
  );
}

const isFinite_ = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isLine = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

interface Options {
  now: number;
  metricIds: Set<string> | undefined;
}

function finding(
  id: string | undefined,
  problem: string,
  remedy: string,
): LedgerFinding {
  return { rule: GATE, problem, remedy, ...(id === undefined ? {} : { id }) };
}

/** The findings of a measured block's `after`: a number, or null with a
 * measure_by date that has not passed. */
function checkAfter(
  id: string,
  where: string,
  raw: Record<string, unknown>,
  now: number,
): LedgerFinding[] {
  // A missing after is a dropped field, not a pending measurement: pending
  // is recorded as an explicit null.
  if (!("after" in raw))
    return [
      finding(
        id,
        `${where} has no after field`,
        "record the number after the decision, or after: null with measure_by: YYYY-MM-DD while it is pending",
      ),
    ];
  if (raw.after !== null)
    return isFinite_(raw.after)
      ? []
      : [
          finding(
            id,
            `${where} has an after that is not a number`,
            "record the measured number, or null with measure_by",
          ),
        ];
  let due: number;
  try {
    due = parseDate(raw.measure_by, `${where}'s measure_by`);
  } catch {
    return [
      finding(
        id,
        `${where} has no after measurement and no measure_by date`,
        "record the number after the decision, or null with measure_by: YYYY-MM-DD",
      ),
    ];
  }
  return due < now
    ? [
        finding(
          id,
          `${where}'s after measurement was due by ${new Date(due).toISOString().slice(0, 10)}`,
          "measure it and record the number, or move measure_by with the reason",
        ),
      ]
    : [];
}

/** The findings of a measured block's `windows`, when present. */
function checkWindows(id: string, where: string, w: unknown): LedgerFinding[] {
  if (w === undefined) return [];
  return Array.isArray(w) && w.length === 2 && w.every(isLine)
    ? []
    : [
        finding(
          id,
          `${where}'s windows are not the two windows the numbers come from`,
          "write [before window, after window], or leave windows out",
        ),
      ];
}

/** The findings of one decision's `measured` block. */
function checkMeasured(id: string, raw: unknown, now: number): LedgerFinding[] {
  const where = `decision ${id}`;
  if (!isRecord(raw))
    return [
      finding(
        id,
        `${where} has no measured block`,
        "add measured: { unit, before, after } with the numbers the decision rests on",
      ),
    ];
  const out: LedgerFinding[] = [];
  if (!isLine(raw.unit))
    out.push(
      finding(
        id,
        `${where} names no unit`,
        "write what the numbers are (runner-minutes per run, minutes, …)",
      ),
    );
  if (!isFinite_(raw.before))
    out.push(
      finding(
        id,
        `${where} has no before measurement`,
        "record the number that motivated the decision",
      ),
    );
  return [
    ...out,
    ...checkAfter(id, where, raw, now),
    ...checkWindows(id, where, raw.windows),
  ];
}

/** The findings of one decision's `reopen` list. */
function checkReopen(
  id: string,
  raw: unknown,
  metricIds: Set<string> | undefined,
): LedgerFinding[] {
  const where = `decision ${id}`;
  if (!Array.isArray(raw) || raw.length === 0)
    return [
      finding(
        id,
        `${where} has no reopen condition`,
        "add reopen: a condition with metric, comparator, threshold and window",
      ),
    ];
  return raw.flatMap((cond, i) => {
    const at = `${where}'s reopen condition #${i + 1}`;
    return isRecord(cond)
      ? conditionFindings(id, at, cond, metricIds)
      : [
          finding(
            id,
            `${at} is not a mapping`,
            "write metric, comparator, threshold and window",
          ),
        ];
  });
}

/** The finding of a condition's metric: unnamed, or not in the registry. */
function metricFindings(
  id: string,
  at: string,
  metric: unknown,
  metricIds: Set<string> | undefined,
): LedgerFinding[] {
  if (typeof metric !== "string" || !SLUG.test(metric))
    return [
      finding(id, `${at} names no metric`, "name the registered metric's id"),
    ];
  if (metricIds !== undefined && !metricIds.has(metric))
    return [
      finding(
        id,
        `${at} names a metric the registry does not carry: ${metric}`,
        "register the metric with a wired source, or name one the registry has",
      ),
    ];
  return [];
}

/** The findings of one reopen condition's fields. */
function conditionFindings(
  id: string,
  at: string,
  cond: Record<string, unknown>,
  metricIds: Set<string> | undefined,
): LedgerFinding[] {
  const out = metricFindings(id, at, cond.metric, metricIds);
  if (typeof cond.comparator !== "string" || !COMPARATORS.has(cond.comparator))
    out.push(finding(id, `${at} has no comparator`, "write one of > >= < <="));
  if (!isFinite_(cond.threshold))
    out.push(
      finding(
        id,
        `${at} has no numeric threshold`,
        "write the number the metric crosses",
      ),
    );
  if (typeof cond.window !== "string" || !WINDOW.test(cond.window))
    out.push(
      finding(
        id,
        `${at} has no window`,
        "write the window the metric is read over: 30d, 4w, 6m, 12h or 100 runs",
      ),
    );
  return out;
}

/**
 * The ledger's `decisions`; throw when the document is not a ledger. An
 * empty list is a ledger: a pipeline that has made no cost decision yet.
 */
export function ledgerDecisions(doc: unknown): unknown[] {
  if (!isRecord(doc)) throw new Error("the ledger is not a mapping");
  if (doc.version !== 1) throw new Error("the ledger has no version: 1");
  if (!Array.isArray(doc.decisions))
    throw new Error("the ledger has no decisions list");
  return doc.decisions;
}

/** Every finding over the ledger's decisions. */
export function checkLedger(
  doc: unknown,
  { now, metricIds }: Options,
): LedgerFinding[] {
  const out: LedgerFinding[] = [];
  const seen = new Set<string>();
  ledgerDecisions(doc).forEach((raw, i) => {
    if (!isRecord(raw)) {
      out.push(
        finding(
          undefined,
          `decision #${i + 1} is not a mapping`,
          "write id, decision, measured and reopen",
        ),
      );
      return;
    }
    if (typeof raw.id !== "string" || !SLUG.test(raw.id)) {
      out.push(
        finding(
          undefined,
          `decision #${i + 1} has no kebab-case id`,
          "give it a stable id such as tests-on-4-cores",
        ),
      );
      return;
    }
    const id = raw.id;
    if (seen.has(id))
      out.push(
        finding(
          id,
          `decision ${id} appears twice`,
          "merge the entries or give the second its own id",
        ),
      );
    seen.add(id);
    if (!isLine(raw.decision))
      out.push(
        finding(
          id,
          `decision ${id} says nothing`,
          "write one line: what changed",
        ),
      );
    out.push(...checkMeasured(id, raw.measured, now));
    out.push(...checkReopen(id, raw.reopen, metricIds));
  });
  return out;
}

/** The metric ids of a registry document; throw when it is not one. */
export function registryIds(doc: unknown): Set<string> {
  if (!isRecord(doc) || !Array.isArray(doc.metrics))
    throw new Error("the registry has no metrics list");
  const ids = new Set<string>();
  for (const m of doc.metrics)
    if (isRecord(m) && typeof m.id === "string") ids.add(m.id);
  return ids;
}

interface Args {
  ledger: string;
  registry: string | undefined;
  now: string | undefined;
}

function parseArgs(args: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const value = () => optionValue(args, i++, usage);
    if (arg === "--metrics") out.registry = value();
    else if (arg === "--now") out.now = value();
    else if (arg.startsWith("--"))
      throw new Error(`unknown option ${arg}\n${usage}`);
    else if (out.ledger !== undefined)
      throw new Error(`more than one ledger\n${usage}`);
    else out.ledger = arg;
  }
  if (out.ledger === undefined) throw new Error(`no ledger given\n${usage}`);
  return { ledger: out.ledger, registry: out.registry, now: out.now };
}

/** The 1-based line of a decision's `id:` entry in the ledger's text. */
function lineOf(raw: string, id: string | undefined): number | undefined {
  if (id === undefined) return undefined;
  const lines = raw.split("\n");
  const at = lines.findIndex((l) =>
    new RegExp(`^\\s*-\\s*id:\\s*['"]?${id}['"]?\\s*(#.*)?$`).test(l),
  );
  return at === -1 ? undefined : at + 1;
}

/** Midnight today in UTC, or the `--now` date. */
function todayOf(now: string | undefined): number {
  if (now !== undefined) return parseDate(now, "--now");
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The registry's metric ids, or why they could not be read. */
function readRegistry(
  registry: string,
): { ids: Set<string> } | { error: string } {
  const reg = readYaml(registry);
  if ("error" in reg) return reg;
  try {
    return { ids: registryIds(reg.doc) };
  } catch (e) {
    return { error: `${registry}: ${(e as Error).message}` };
  }
}

export function main(args = process.argv.slice(2)): number {
  const { ledger, registry, now } = parseArgs(args);
  const today = todayOf(now);
  const file = readYaml(ledger);
  if ("error" in file) return couldNotCheck(GATE, file.error);
  if (file.raw.trim() === "")
    return couldNotCheck(GATE, `the ledger is empty: ${ledger}`);
  const reg = registry === undefined ? undefined : readRegistry(registry);
  if (reg !== undefined && "error" in reg)
    return couldNotCheck(GATE, reg.error);
  const metricIds = reg?.ids;
  let ledgerFindings: LedgerFinding[];
  try {
    ledgerFindings = checkLedger(file.doc, { now: today, metricIds });
  } catch (e) {
    return couldNotCheck(GATE, `${ledger}: ${(e as Error).message}`);
  }
  const findings: Finding[] = ledgerFindings.map(({ id, ...f }) => ({
    ...f,
    file: ledger,
    line: lineOf(file.raw, id),
  }));
  if (findings.length > 0) {
    reportFindings(findings);
    console.log(`${GATE}: ${findings.length} finding(s) in ${ledger}`);
    return 1;
  }
  const decisions = ledgerDecisions(file.doc).length;
  if (decisions === 0) {
    console.log(`OK — 0 decision(s) in ${ledger}: nothing to check yet`);
    return 0;
  }
  const checked =
    metricIds === undefined
      ? "metrics not checked against a registry"
      : `metrics checked against ${registry}`;
  console.log(
    `OK — ${decisions} decision(s) in ${ledger}, each measured and with a checkable reopen condition; ${checked}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());

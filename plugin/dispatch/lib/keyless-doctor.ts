/**
 * `jig doctor`'s check of the dispatcher's tracker credentials over the
 * last day. The cost ledger is the index: a tick that had no credential for
 * a tracker kept its calls there under no credential, with its run id as
 * the caller (`shared/outbound/missing-credential.ts`), so only those ticks'
 * receipts are opened, the newest first and at most `RECEIPTS_READ` of
 * them. Each receipt's `noCredential` (`no-credential.ts`) names the
 * repositories that tracker serves; the check counts each repository's
 * keyless ticks and names the callers, any skill or pass the ledger kept
 * under no credential among them. A repository whose newest tick since
 * then read the tracker with a credential is a warning, not a failure. Its
 * fix is the caller's environment, not the key.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck } from "../../runtime/component.ts";
import { NO_CREDENTIAL } from "../../shared/outbound/missing-credential.ts";
import { type LedgerRow, ledgerReport } from "../../shared/outbound/ledger.ts";
import { readReceipt, stateRoot, type TickReceipt } from "../receipts.ts";
import type { NoCredential } from "./no-credential.ts";

const ID = "dispatch:tracker-credential";
const WINDOW_MS = 24 * 3_600_000;
/** The most callers the detail names; the rest are counted. */
const CALLERS_SHOWN = 10;
/** The most receipts the check opens: the newest keyless ticks, and one credentialed tick per repository. */
const RECEIPTS_READ = 50;
/** The most receipt files the whole check opens, keyless ticks and recovery candidates together; evidence past it stays unresolved. */
const RECEIPTS_BUDGET = 200;
const TICK = /^tick:(\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+-[a-f\d]{8})$/;

/** One reason and repository's keyless ticks. */
interface Keyless {
  system: string;
  reason: string;
  remedy: string;
  repo: string;
  ticks: string[];
}

/** `items`, the first `CALLERS_SHOWN` named and the rest counted. */
function named(items: readonly string[]): string {
  const shown = items.slice(0, CALLERS_SHOWN).join(", ");
  const more = items.length - CALLERS_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

// Code-unit order, so run ids and callers sort the same on every host.
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** The run ids the ledger's rows name as tick callers, newest first. */
function tickRuns(rows: readonly LedgerRow[]): string[] {
  const runs = new Set(
    rows.flatMap((r) => {
      const run = TICK.exec(r.caller)?.[1];
      return run === undefined ? [] : [run];
    }),
  );
  return [...runs].sort(byCodeUnit).reverse();
}

/** Why the receipts under `root` cannot be read; `null` when they can or there are none. */
function receiptsUnreadable(root: string): string | null {
  try {
    readdirSync(join(root, "receipts"));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return error instanceof Error ? error.message : String(error);
  }
}

/** Receipts read once per check, by run id, with how many files the check may still open. */
interface Receipts {
  root: string;
  cache: Map<string, TickReceipt | null>;
  budget: number;
}

/** The receipt of the tick `runId`, kept under the day it started; `undefined` once the budget is spent and it was not read before. */
function receiptOf(
  receipts: Receipts,
  runId: string,
): TickReceipt | null | undefined {
  if (receipts.cache.has(runId)) return receipts.cache.get(runId);
  if (receipts.budget <= 0) return undefined;
  receipts.budget -= 1;
  const receipt = readReceipt(
    join(receipts.root, "receipts", runId.slice(0, 10), `${runId}.json`),
  );
  receipts.cache.set(runId, receipt);
  return receipt;
}

/** The `noCredential` entries `receipt` carries, or why they cannot be trusted: a field that is not a list, or an entry that is not a system's missing credential with its repositories. */
function keylessEntries(
  receipt: TickReceipt | null,
  keyless = true,
): { entries: NoCredential[] } | { why: string } {
  if (receipt === null) return { why: "its receipt is missing or unreadable" };
  const field: unknown = receipt.noCredential;
  // A run the ledger kept under no credential owes the field; a credentialed one does not carry it.
  if (field === undefined)
    return keyless
      ? { why: "its receipt names no noCredential" }
      : { entries: [] };
  if (!Array.isArray(field)) return { why: "its noCredential is not a list" };
  for (const e of field as unknown[]) {
    const m = e as Partial<NoCredential> | null;
    if (
      m === null ||
      typeof m !== "object" ||
      typeof m.system !== "string" ||
      typeof m.reason !== "string" ||
      typeof m.remedy !== "string" ||
      !Array.isArray(m.repos) ||
      !m.repos.every((r) => typeof r === "string")
    )
      return { why: "an entry of its noCredential is malformed" };
  }
  if (
    field.length === 0 ||
    (field as NoCredential[]).every((e) => e.repos.length === 0)
  )
    return { why: "its noCredential names no repository" };
  return { entries: field as NoCredential[] };
}

/**
 * Whether `receipt` read the tracker of `system` for the repository `repo`
 * (a slug, or a path where the forge named none): its tracker record is
 * there and answered, and the tick had a credential for it.
 */
function readTracker(
  receipt: TickReceipt | null,
  system: string,
  repo: string,
): boolean {
  if (receipt === null) return false;
  if (
    "why" in keylessEntries(receipt, false) ||
    (receipt.noCredential ?? []).some(
      (n) =>
        n.recovered !== true && n.system === system && n.repos.includes(repo),
    )
  )
    return false;
  return receipt.repos.some(
    (r) =>
      (r.slug ?? r.path) === repo &&
      r.records.some(
        (rec) =>
          rec.record === "tracker" &&
          rec.ok &&
          typeof rec.source === "string" &&
          rec.source.startsWith(`${system} `),
      ),
  );
}

/** The check over the day before `nowMs`, from the receipts under `root` and the ledger at `ledgerPath`. */
export function keylessCheck(opts: {
  root?: string;
  ledgerPath?: string;
  nowMs: number;
}): DoctorCheck {
  const root = opts.root ?? stateRoot();
  const ledger = ledgerReport({
    since: opts.nowMs - WINDOW_MS,
    until: opts.nowMs,
    ...(opts.ledgerPath === undefined ? {} : { path: opts.ledgerPath }),
  });
  if (ledger.unavailable === true)
    return {
      id: ID,
      status: "warn",
      detail:
        "the cost ledger could not be read, so whether ticks ran without a tracker credential is unknown",
    };
  const keylessRows = ledger.rows.filter((r) => r.credential === NO_CREDENTIAL);
  const keylessRuns = tickRuns(keylessRows);
  const others = [
    ...new Set(
      keylessRows.filter((r) => !TICK.test(r.caller)).map((r) => r.caller),
    ),
  ].sort(byCodeUnit);
  if (keylessRuns.length === 0)
    return others.length === 0
      ? {
          id: ID,
          status: "pass",
          detail:
            "no tick in the last 24 hours ran without a tracker credential",
        }
      : {
          id: ID,
          status: "warn",
          detail: `no tick in the last 24 hours ran without a tracker credential, but these callers had none: ${named(others)}`,
        };
  const unreadable = receiptsUnreadable(root);
  if (unreadable !== null)
    return {
      id: ID,
      status: "fail",
      detail: `${keylessRuns.length} tick${keylessRuns.length === 1 ? "" : "s"} in the last 24 hours ran without a tracker credential, and their receipts could not be read: ${unreadable}`,
      fix: `make ${join(root, "receipts")} readable, then run jig doctor again`,
    };
  const receipts: Receipts = {
    root,
    cache: new Map(),
    budget: RECEIPTS_BUDGET,
  };
  const groups = new Map<string, Keyless>();
  // Ticks whose receipt could not be read stay unresolved failures, named with what was wrong.
  const unresolved: string[] = [];
  for (const runId of keylessRuns.slice(0, RECEIPTS_READ)) {
    const receipt = receiptOf(receipts, runId);
    const found =
      receipt === undefined
        ? { why: "its receipt was not opened: the read budget was spent" }
        : keylessEntries(receipt);
    if ("why" in found) {
      unresolved.push(`tick:${runId} (${found.why})`);
      continue;
    }
    // An incident the tick recovered from within itself (every cut reading completed) is history, not an unresolved failure.
    for (const missing of found.entries.filter((e) => e.recovered !== true))
      for (const repo of missing.repos) {
        const key = `${missing.reason}\u0000${repo}`;
        const group = groups.get(key) ?? {
          system: missing.system,
          reason: missing.reason,
          remedy: missing.remedy,
          repo,
          ticks: [],
        };
        group.ticks.push(`tick:${runId}`);
        groups.set(key, group);
      }
  }
  const unexamined = Math.max(0, keylessRuns.length - RECEIPTS_READ);
  const read =
    keylessRuns.length > RECEIPTS_READ
      ? ` (the newest ${RECEIPTS_READ} of ${keylessRuns.length} keyless ticks read)`
      : "";
  // The newest tick since the newest keyless one that read this repository's tracker with a credential.
  const credentialed = (system: string) =>
    tickRuns(
      ledger.rows.filter(
        (r) => r.system === system && r.credential !== NO_CREDENTIAL,
      ),
    );
  const recovered = (g: Keyless): boolean => {
    const newest = g.ticks[0]?.slice("tick:".length) ?? "";
    return credentialed(g.system)
      .filter((run) => run > newest)
      .slice(0, RECEIPTS_READ)
      .some((run) => {
        const receipt = receiptOf(receipts, run);
        return receipt !== undefined && readTracker(receipt, g.system, g.repo);
      });
  };
  const all = [...groups.values()];
  const since = new Map(all.map((g) => [g, recovered(g)]));
  const lines = all.map(
    (g) =>
      `${g.reason} for ${g.repo}: ${g.ticks.length} tick${g.ticks.length === 1 ? "" : "s"} in the last 24 hours ran without it (${named(g.ticks)})${since.get(g) === true ? "; the newest tick since read it with one" : ""}`,
  );
  const remedies = [...new Set(all.map((g) => g.remedy))];
  const unreadRuns =
    unresolved.length === 0
      ? ""
      : `; ticks whose receipts could not be read: ${named(unresolved)}`;
  const detail = `${lines.length === 0 ? `${keylessRuns.length} ticks in the last 24 hours ran without a tracker credential` : lines.join("; ")}${read}${unreadRuns}${others.length === 0 ? "" : `; other callers with no key: ${named(others)}`}`;
  return {
    id: ID,
    status:
      unresolved.length === 0 &&
      unexamined === 0 &&
      all.every((g) => since.get(g) === true)
        ? "warn"
        : "fail",
    detail,
    fix: `${remedies.length === 0 ? "give those ticks a tracker credential" : remedies.join("; ")}, in the environment of whatever starts those ticks and callers (the receipts' startedBy names it)`,
  };
}

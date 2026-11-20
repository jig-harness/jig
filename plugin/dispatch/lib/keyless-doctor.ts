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

const ID = "dispatch:tracker-credential";
const WINDOW_MS = 24 * 3_600_000;
/** The most callers the detail names; the rest are counted. */
const CALLERS_SHOWN = 10;
/** The most receipts the check opens: the newest keyless ticks, and one credentialed tick per repository. */
const RECEIPTS_READ = 50;
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

/** The run ids the ledger's rows name as tick callers, newest first. */
function tickRuns(rows: readonly LedgerRow[]): string[] {
  const runs = new Set(
    rows.flatMap((r) => {
      const run = TICK.exec(r.caller)?.[1];
      return run === undefined ? [] : [run];
    }),
  );
  return [...runs].sort().reverse();
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

/** The receipt of the tick `runId`, kept under the day it started. */
function receiptOf(root: string, runId: string): TickReceipt | null {
  return readReceipt(
    join(root, "receipts", runId.slice(0, 10), `${runId}.json`),
  );
}

/** Whether `receipt` read the repository `repo` (a slug, or a path where the forge named none). */
const readRepo = (receipt: TickReceipt | null, repo: string): boolean =>
  receipt?.repos.some((r) => (r.slug ?? r.path) === repo) === true;

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
  ].sort();
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
  const groups = new Map<string, Keyless>();
  for (const runId of keylessRuns.slice(0, RECEIPTS_READ))
    for (const missing of receiptOf(root, runId)?.noCredential ?? [])
      for (const repo of Array.isArray(missing.repos) ? missing.repos : []) {
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
  const read =
    keylessRuns.length > RECEIPTS_READ
      ? ` (the newest ${RECEIPTS_READ} of ${keylessRuns.length} keyless ticks read)`
      : "";
  // A tick since the newest keyless one that read the repository's tracker with a credential.
  const credentialed = (system: string) =>
    tickRuns(
      ledger.rows.filter(
        (r) => r.system === system && r.credential !== NO_CREDENTIAL,
      ),
    );
  const recovered = (g: Keyless): boolean => {
    const newest = g.ticks[0]?.slice("tick:".length) ?? "";
    const since = credentialed(g.system).find((run) => run > newest);
    return since !== undefined && readRepo(receiptOf(root, since), g.repo);
  };
  const all = [...groups.values()];
  const since = new Map(all.map((g) => [g, recovered(g)]));
  const lines = all.map(
    (g) =>
      `${g.reason} for ${g.repo}: ${g.ticks.length} tick${g.ticks.length === 1 ? "" : "s"} in the last 24 hours ran without it (${named(g.ticks)})${since.get(g) === true ? "; the newest tick since read it with one" : ""}`,
  );
  const remedies = [...new Set(all.map((g) => g.remedy))];
  const detail = `${lines.length === 0 ? `${keylessRuns.length} ticks in the last 24 hours ran without a tracker credential` : lines.join("; ")}${read}${others.length === 0 ? "" : `; other callers with no key: ${named(others)}`}`;
  return {
    id: ID,
    status:
      all.length > 0 && all.every((g) => since.get(g) === true)
        ? "warn"
        : "fail",
    detail,
    fix: `${remedies.length === 0 ? "give those ticks a tracker credential" : remedies.join("; ")}, in the environment of whatever starts those ticks and callers (the receipts' startedBy names it)`,
  };
}

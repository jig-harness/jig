/**
 * `jig doctor`'s check of the dispatcher's tracker credentials: over the
 * last day, the ticks whose receipts say they had no credential for a
 * tracker (`noCredential`, `no-credential.ts`), counted for each repository
 * that tracker serves, with the callers the cost ledger kept under no
 * credential (`shared/outbound/credential-latch.ts`): each such tick's run
 * id, and any skill or pass that had no key either. Its fix is the caller's
 * environment, not the key.
 */
import type { DoctorCheck } from "../../runtime/component.ts";
import { swallow } from "../../shared/errors.ts";
import { NO_CREDENTIAL } from "../../shared/outbound/credential-latch.ts";
import { ledgerReport } from "../../shared/outbound/ledger.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import { readReceipt, receiptPaths, stateRoot } from "../receipts.ts";

const ID = "dispatch:tracker-credential";
const WINDOW_MS = 24 * 3_600_000;
/** The most callers the detail names; the rest are counted. */
const CALLERS_SHOWN = 10;

/** One reason and repository's keyless ticks. */
interface Keyless {
  reason: string;
  remedy: string;
  repo: string;
  ticks: string[];
}

/** The receipts of the ticks that started within the window, read from the days it spans only. */
function windowReceipts(root: string, sinceMs: number) {
  const firstDay = isoFromMs(sinceMs).slice(0, 10);
  let paths: string[];
  try {
    paths = receiptPaths(root);
  } catch (error) {
    swallow(error, "receipts that do not list say nothing of a credential");
    return [];
  }
  return paths
    .filter(
      (path) =>
        (/(\d{4}-\d{2}-\d{2})[/\\][^/\\]+$/.exec(path)?.[1] ?? "") >= firstDay,
    )
    .flatMap((path) => {
      const receipt = readReceipt(path);
      return receipt !== null && parseMs(receipt.startedAt) >= sinceMs
        ? [receipt]
        : [];
    });
}

/** `items`, the first `CALLERS_SHOWN` named and the rest counted. */
function named(items: readonly string[]): string {
  const shown = items.slice(0, CALLERS_SHOWN).join(", ");
  const more = items.length - CALLERS_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** The check over the day before `nowMs`, from the receipts under `root` and the ledger at `ledgerPath`. */
export function keylessCheck(opts: {
  root?: string;
  ledgerPath?: string;
  nowMs: number;
}): DoctorCheck {
  const sinceMs = opts.nowMs - WINDOW_MS;
  const groups = new Map<string, Keyless>();
  for (const receipt of windowReceipts(opts.root ?? stateRoot(), sinceMs))
    for (const missing of receipt.noCredential ?? [])
      for (const repo of Array.isArray(missing.repos) ? missing.repos : []) {
        const key = `${missing.reason}\u0000${repo}`;
        const group = groups.get(key) ?? {
          reason: missing.reason,
          remedy: missing.remedy,
          repo,
          ticks: [],
        };
        group.ticks.push(`tick:${receipt.runId}`);
        groups.set(key, group);
      }
  if (groups.size === 0)
    return {
      id: ID,
      status: "pass",
      detail: "no tick in the last 24 hours ran without a tracker credential",
    };
  const ledger = ledgerReport({
    since: sinceMs,
    until: opts.nowMs,
    ...(opts.ledgerPath === undefined ? {} : { path: opts.ledgerPath }),
  });
  const ticks = new Set([...groups.values()].flatMap((g) => g.ticks));
  const others = [
    ...new Set(
      ledger.rows
        .filter((r) => r.credential === NO_CREDENTIAL && !ticks.has(r.caller))
        .map((r) => r.caller),
    ),
  ].sort();
  const lines = [...groups.values()].map(
    (g) =>
      `${g.reason} for ${g.repo}: ${g.ticks.length} tick${g.ticks.length === 1 ? "" : "s"} in the last 24 hours ran without it (${named(g.ticks)})`,
  );
  const remedies = [...new Set([...groups.values()].map((g) => g.remedy))];
  return {
    id: ID,
    status: "fail",
    detail: `${lines.join("; ")}${others.length === 0 ? "" : `; other callers with no key: ${named(others)}`}`,
    fix: `${remedies.join("; ")}, in the environment of whatever starts those ticks and callers (the receipts' startedBy names it)`,
  };
}

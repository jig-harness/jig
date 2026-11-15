/**
 * Run tabs as a collection kind: the Orca terminal tabs Jig opened for a run
 * (`shared/orca-tabs.ts`) whose run was killed before it could close its own
 * tab (killed outright, or by a host reboot), and parked run tabs nobody returned to.
 *
 * The inventory is the run-tab records joined to `orca terminal list`. A tab
 * is kept while its shell is gone or was reused (the record no longer proves
 * the tab is the run's), while the shell has any child process (someone typed
 * a command into it), and while its last output or its opening falls inside
 * the guard. A process table that cannot be read collects nothing: every tab
 * counts as busy. The record of a tab Orca no longer lists is deleted, and
 * Orca is not called for it.
 *
 * Removal closes the recorded terminal (`orca terminal close --terminal`),
 * never its whole tab, so a pane a person added beside it stays; Orca
 * refusing the close is recorded as live. Every Orca call uses the command
 * the machine's configuration names, never the one a record carries.
 */
import { isRecord } from "../../shared/guards.ts";
import {
  orcaEnvelope,
  orcaErrorText,
  type OrcaRunner,
} from "../../shared/orca.ts";
import {
  closeRunTab,
  defaultRunTabDeps,
  forgetRunTab,
  type RunTab,
  type RunTabDeps,
  readRunTabs,
  tabState,
} from "../../shared/orca-tabs.ts";
import type { ProcessRow } from "../../shared/process-table.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { CollectionKind, Proof, Resource } from "../types.ts";

/** More rows than a machine holds terminals; a listing Orca still cuts short is incomplete. */
const LIST_LIMIT = 5000;

/** Seconds one process-table read may take. */
const TABLE_CALL_SEC = 10;

/** What Orca's listing says of one terminal. */
interface Listed {
  /** Epoch milliseconds of the terminal's last output; null when Orca has none. */
  lastOutputAt: number | null;
}

/** Orca's terminals by handle, and whether the listing covers every terminal. */
interface Listing {
  terminals: Map<string, Listed>;
  complete: boolean;
}

/** The listing in `orca terminal list`'s result; a string says why it does not read. */
function readListing(result: Record<string, unknown>): Listing | string {
  if (!Array.isArray(result.terminals))
    return "orca terminal list answered without a terminal list";
  const terminals = new Map<string, Listed>();
  for (const terminal of result.terminals) {
    if (!isRecord(terminal) || typeof terminal.handle !== "string") continue;
    const last = terminal.lastOutputAt;
    terminals.set(terminal.handle, {
      lastOutputAt:
        typeof last === "number" && Number.isFinite(last) ? last : null,
    });
  }
  const scope = result.hostScope;
  const everyHost =
    isRecord(scope) &&
    Array.isArray(scope.omittedHostIds) &&
    scope.omittedHostIds.length === 0;
  return { terminals, complete: everyHost && result.truncated !== true };
}

async function listTerminals(
  command: string,
  orca: OrcaRunner,
): Promise<Outcome<Listing, "orca-failed">> {
  const done = await orca(command, [
    "terminal",
    "list",
    "--limit",
    String(LIST_LIMIT),
    "--json",
  ]);
  const envelope = orcaEnvelope(done.stdout);
  if (done.code !== 0 || envelope?.ok !== true)
    return failed(
      "orca-failed",
      `orca terminal list failed (exit ${done.code}): ${
        envelope?.ok === false
          ? orcaErrorText(envelope)
          : (done.stdout || done.stderr).trim().slice(0, 200)
      }`,
    );
  const listing = readListing(envelope.result);
  return typeof listing === "string"
    ? failed("orca-failed", listing)
    : ok(listing);
}

/** The moment the tab last showed it was in use: its last output, else its opening. */
function lastActivity(tab: RunTab, listed: Listed): number | null {
  const opened = parseMs(tab.openedAt);
  const known = [
    listed.lastOutputAt,
    Number.isFinite(opened) ? opened : null,
  ].filter((at): at is number => at !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/** The proof for `tab` against Orca's listing and the process table. */
export function runTabProof(
  tab: RunTab,
  listing: Listing,
  rows: ProcessRow[] | null,
  guardMs: number,
  now: number,
): Proof {
  const listed = listing.terminals.get(tab.handle);
  if (listed === undefined)
    return listing.complete
      ? {
          state: "dead",
          reason:
            "Orca no longer lists the tab; only its record is deleted, Orca is not called",
          details: { action: "forget-record" },
        }
      : {
          state: "unverified",
          reason:
            "Orca's terminal list does not cover every terminal, and it does not name this tab",
        };
  if (rows === null)
    return {
      state: "live",
      reason: "the process table could not be read: the tab counts as busy",
    };
  const state = tabState(tab, rows);
  if (state === "gone")
    return {
      state: "live",
      reason: `its shell (PID ${tab.shellPid}) is gone or was reused: the record no longer proves the tab is the run's`,
    };
  if (state === "busy")
    return {
      state: "live",
      reason: `its shell (PID ${tab.shellPid}) has a child process`,
    };
  const last = lastActivity(tab, listed);
  if (last === null)
    return {
      state: "unverified",
      reason: "neither Orca's last output nor the record's opening time reads",
    };
  const details = { lastActivity: isoFromMs(last), action: "close-terminal" };
  if (now - last < guardMs)
    return {
      state: "live",
      reason: `last in use ${isoFromMs(last)}, inside the ${guardMs / 3_600_000}-hour guard`,
      details,
    };
  return {
    state: "dead",
    reason: `idle run tab: its shell (PID ${tab.shellPid}) runs no command, last in use ${isoFromMs(last)}, past the ${guardMs / 3_600_000}-hour guard`,
    details,
  };
}

/**
 * The `orca-terminals` kind for the machine, with Orca's `command` and a
 * guard of `idleHours`. `deps` replaces the record store, Orca, the process
 * table and the clock in tests.
 */
export function orcaTerminalsKind(
  command: string,
  idleHours: number,
  deps: RunTabDeps = defaultRunTabDeps(),
): CollectionKind {
  const guardMs = idleHours * 3_600_000;
  const tabs = new Map<string, RunTab>();
  let listing: Listing = { terminals: new Map(), complete: false };
  let rows: ProcessRow[] | null = null;
  /** The record as gc acts on it: closed through the machine's command. */
  const tabOf = (resource: Resource): RunTab | undefined => {
    const tab = tabs.get(resource.id);
    return tab === undefined ? undefined : { ...tab, orca: command };
  };
  return {
    name: "orca-terminals",
    declaration: "machine gc.orca.command",
    inventory: async () => {
      const listed = await listTerminals(command, deps.orca);
      if (!listed.ok) return listed;
      listing = listed.value;
      rows = await deps.table(TABLE_CALL_SEC);
      tabs.clear();
      for (const tab of readRunTabs(deps.root)) tabs.set(tab.handle, tab);
      return ok(
        [...tabs.values()].map((tab) => ({
          id: tab.handle,
          details: {
            title: tab.title,
            subject: tab.subject,
            worktree: tab.worktree,
            openedAt: tab.openedAt,
          },
        })),
      );
    },
    prove: async (resource): Promise<Proof> => {
      const tab = tabOf(resource);
      if (tab === undefined)
        return { state: "unverified", reason: "the tab's record is gone" };
      return runTabProof(tab, listing, rows, guardMs, deps.now());
    },
    collect: async (resource) => {
      const tab = tabOf(resource);
      if (tab === undefined)
        return { outcome: "refused", reason: "the tab's record is gone" };
      // The listing is read again right before acting: a tab used since the
      // inventory, or one Orca closed meanwhile, is judged on what Orca says now.
      const fresh = await listTerminals(command, deps.orca);
      if (!fresh.ok)
        return { outcome: "refused", reason: fresh.failure.reason };
      const table = await deps.table(TABLE_CALL_SEC);
      const proof = runTabProof(tab, fresh.value, table, guardMs, deps.now());
      if (proof.state !== "dead")
        return { outcome: "refused", reason: proof.reason };
      if (!fresh.value.terminals.has(tab.handle)) {
        forgetRunTab(deps.root, tab.handle);
        return {
          outcome: "collected",
          reason: "Orca no longer lists the tab; its record was deleted",
        };
      }
      const closed = await closeRunTab(tab, deps);
      if (closed === "closed")
        return {
          outcome: "collected",
          reason: "the run tab's terminal was closed",
        };
      if (closed === "gone")
        return {
          outcome: "collected",
          reason:
            "Orca or the process table shows the tab gone; its record was deleted",
        };
      return {
        outcome: "refused",
        reason: `the close was refused: ${typeof closed === "string" ? closed : closed.failed}`,
      };
    },
    describe: (resource) => {
      const tab = tabs.get(resource.id);
      return tab === undefined
        ? `run tab ${resource.id}`
        : `run tab ${tab.handle} (${tab.title}) in ${tab.worktree}`;
    },
    exclusive: (body) => body(),
  };
}

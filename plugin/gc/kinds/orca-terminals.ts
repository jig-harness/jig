/**
 * Run tabs as a collection kind: the Orca terminal tabs Jig opened for a run
 * (`shared/orca-tabs.ts`) whose run was killed before it could close its own
 * tab, and parked run tabs nobody returned to.
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
 * the machine's configuration names, never the one a record carries, and the
 * records are read from the machine's Jig state, never from a directory the
 * environment names: neither may widen what gc closes.
 */
import { isRecord } from "../../shared/guards.ts";
import {
  ORCA_LIST_LIMIT,
  orcaEnvelope,
  orcaErrorText,
  orcaFailure,
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

/** The latest epoch millisecond a Temporal instant holds. */
const MAX_EPOCH_MS = 8.64e15;

/** Seconds one process-table read may take. */
const TABLE_CALL_SEC = 10;

/** What Orca's listing says of one terminal. */
interface Listed {
  /** Epoch milliseconds of the terminal's last output; null when Orca has none. */
  lastOutputAt: number | null;
  /** Orca sent a last-output value that is not a time: the tab's activity is unknown. */
  invalidOutput: boolean;
  /** Orca listed the handle more than once: no row proves anything about the tab. */
  ambiguous: boolean;
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
  let wellFormed = true;
  for (const terminal of result.terminals) {
    const row = readTerminal(terminal);
    if (row === null) wellFormed = false;
    else {
      const earlier = terminals.get(row.handle);
      if (earlier !== undefined) {
        wellFormed = false;
        earlier.ambiguous = true;
      } else terminals.set(row.handle, row.listed);
    }
  }
  return {
    terminals,
    complete:
      wellFormed && coversEveryHost(result) && result.truncated === false,
  };
}

/** Whether `hostScope` names its hosts and omits none. */
function coversEveryHost(result: Record<string, unknown>): boolean {
  const scope = result.hostScope;
  return (
    isRecord(scope) &&
    Array.isArray(scope.hostIds) &&
    Array.isArray(scope.omittedHostIds) &&
    scope.omittedHostIds.length === 0
  );
}

/** One terminal row of the listing; null when it is not a row with a handle. */
function readTerminal(
  terminal: unknown,
): { handle: string; listed: Listed } | null {
  if (!isRecord(terminal) || typeof terminal.handle !== "string") return null;
  const last = terminal.lastOutputAt;
  const valid =
    typeof last === "number" &&
    Number.isFinite(last) &&
    Math.abs(last) <= MAX_EPOCH_MS;
  return {
    handle: terminal.handle,
    listed: {
      lastOutputAt: valid ? last : null,
      invalidOutput: !valid && last !== null && last !== undefined,
      ambiguous: false,
    },
  };
}

async function listTerminals(
  command: string,
  orca: OrcaRunner,
): Promise<Outcome<Listing, "orca-failed">> {
  const done = await orca(command, [
    "terminal",
    "list",
    "--limit",
    String(ORCA_LIST_LIMIT),
    "--json",
  ]);
  const envelope = orcaEnvelope(done.stdout);
  if (done.code !== 0 || envelope?.ok !== true)
    return failed(
      "orca-failed",
      envelope?.ok === false
        ? `orca terminal list failed: ${orcaErrorText(envelope)}`
        : `orca terminal list failed ${orcaFailure(done)}`,
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
function runTabProof(
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
  if (listed.ambiguous)
    return {
      state: "unverified",
      reason: "Orca lists this handle more than once: its activity is unknown",
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
  if (listed.invalidOutput)
    return {
      state: "unverified",
      reason: "Orca's last output for the tab is not a time",
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
  deps: RunTabDeps = defaultRunTabDeps({}),
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
      // Records first: a tab recorded after the listing is then one the
      // listing may name, never one it seems to have dropped.
      tabs.clear();
      for (const tab of readRunTabs(deps.root)) tabs.set(tab.handle, tab);
      if (tabs.size === 0) return ok([]);
      const listed = await listTerminals(command, deps.orca);
      if (!listed.ok) return listed;
      listing = listed.value;
      rows = await deps.table(TABLE_CALL_SEC);
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

/**
 * The host's load factor. Each tick reads its host's gauges once, when the
 * act phase builds its apply state under the act lock (`load-read.ts`), so
 * two ticks never spend the same headroom; each gauge's fill is measured
 * against its line (`load-config.ts`), `1` at the line, and the load factor
 * is the fullest gauge's fill, shown with the gauge that binds: "82% ·
 * memory binds". A gauge the host cannot read is left out and says why.
 *
 * A launch is admitted only while every gauge stays under its line with the
 * launch counted: the memory gauge counts the launch's kind's reservation
 * (its measured 90th percentile, else its default, `load-samples.ts`) and
 * every reservation this tick has already admitted; the gauges that cannot
 * express a reservation must be under their line. The test lock's waiters
 * hold only pickups and drive passes. A new pickup also keeps room for a
 * drive or follow-up after it: the memory left above the floor must fit the
 * larger of their reservations, an account slot must stay free, and every
 * other gauge must stay under its line.
 *
 * Account slots and walls are admitted as before (`accounts.ts`); their
 * gauge only reports how full they are, beside the others. With
 * `load.enforce: false`, the default, a launch a gauge refuses still starts
 * and is reported as one the load factor would hold.
 */
import type { NotAdmitted } from "./accounts.ts";
import type {
  LineLoad,
  LineLoadGauge,
  LineLoadHold,
  LoadGauge,
  LoadKind,
} from "./dashboard-contract.ts";
import { LOAD_KINDS, type LoadSettings } from "./load-config.ts";
import type { LoadReading } from "./load-read.ts";
import { MEASURED_AFTER, percentile90 } from "./load-samples.ts";

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** The account slots the gauge reads: those held, and those of accounts that can take a launch. */
export interface AccountsReading {
  held: number;
  capacity: number;
}

/** What the load factor carries through a tick's act phase. */
export interface LoadState {
  settings: LoadSettings;
  reading: LoadReading;
  accounts: AccountsReading;
  reservations: LineLoad["reservations"];
  /** The memory reserved by the launches this tick admitted so far. */
  spentBytes: number;
  /** The account slots this tick's admitted launches took. */
  spentSlots: number;
  holds: LineLoadHold[];
}

/** Each kind's reservation from its samples, newest first: the 90th percentile once it has `MEASURED_AFTER`, else its default. */
export function reservationsOf(
  settings: LoadSettings,
  samples: ReadonlyMap<LoadKind, number[]>,
): LineLoad["reservations"] {
  return LOAD_KINDS.map((kind) => {
    const own = samples.get(kind) ?? [];
    const measured = own.length >= MEASURED_AFTER;
    return {
      kind,
      bytes: measured
        ? (percentile90(own) ?? settings.reservations[kind])
        : settings.reservations[kind],
      samples: own.length,
      measured,
    };
  });
}

/** The account slots of the accounts a launch can be admitted on: those listed, not walled and not refused. */
export function accountsReading(
  table: ReadonlyArray<{
    account: { name: string; maxPerAccount: number };
    held: number;
    wall: unknown;
    wallUnrecorded: boolean;
  }>,
  refused: readonly NotAdmitted[],
): AccountsReading {
  const open = table.filter(
    (s) =>
      s.wall === null &&
      !s.wallUnrecorded &&
      !refused.some((r) => r.account === s.account.name),
  );
  return {
    held: open.reduce((n, s) => n + s.held, 0),
    capacity: open.reduce((n, s) => n + s.account.maxPerAccount, 0),
  };
}

export function loadState(
  settings: LoadSettings,
  reading: LoadReading,
  accounts: AccountsReading,
  samples: ReadonlyMap<LoadKind, number[]>,
): LoadState {
  return {
    settings,
    reading,
    accounts,
    reservations: reservationsOf(settings, samples),
    spentBytes: 0,
    spentSlots: 0,
    holds: [],
  };
}

/** A kind's reservation in bytes. */
export function reservation(state: LoadState, kind: LoadKind): number {
  return (
    state.reservations.find((r) => r.kind === kind)?.bytes ??
    state.settings.reservations[kind]
  );
}

/** The memory gauge's floor and what is used above it, `extra` bytes counted; `null` when memory does not read. */
function memory(
  state: LoadState,
  extra = 0,
): { floor: number; usable: number; used: number; available: number } | null {
  const available = state.reading.host.availableBytes;
  const total = state.reading.totalBytes;
  if (available === null || !(total > 0)) return null;
  const floor = total * state.settings.memoryFree;
  return {
    floor,
    usable: total - floor,
    used: total - available + state.spentBytes + extra,
    available: available - state.spentBytes,
  };
}

/** A "free space above a floor" fill: 1 when the free amount reaches the floor. */
function aboveFloor(free: number, total: number, floor: number): number {
  return (total - free) / Math.max(total - floor, 1);
}

/** Each gauge as the tick read it, with the launches it admitted counted. */
export function gauges(state: LoadState): LineLoadGauge[] {
  const { settings, reading, accounts } = state;
  const out: LineLoadGauge[] = [];
  const mem = memory(state);
  out.push({
    gauge: "memory",
    fill: mem === null ? null : mem.used / mem.usable,
    reads:
      mem === null
        ? reading.platform === "darwin"
          ? "memory not read on macOS, which reports no reclaimable memory"
          : "memory not read"
        : `${gib(mem.available)} available of ${gib(reading.totalBytes)}`,
    line: `${pct(settings.memoryFree)} of memory kept free`,
  });
  const { load1, cores } = reading.host;
  out.push({
    gauge: "processors",
    fill: load1 === null ? null : load1 / cores / settings.loadPerCore,
    reads:
      load1 === null
        ? `processors not read on ${reading.platform === "win32" ? "Windows, which has no load average" : reading.platform}`
        : `load ${load1.toFixed(1)} on ${cores} cores`,
    line: `${settings.loadPerCore} per core`,
  });
  out.push(
    "unread" in reading.lock
      ? {
          gauge: "test-lock",
          fill: null,
          reads: reading.lock.unread,
          line: `${settings.lockWaiters} waiting`,
        }
      : {
          gauge: "test-lock",
          fill: reading.lock.waiters / settings.lockWaiters,
          reads: `${reading.lock.holders} holding, ${reading.lock.waiters} waiting`,
          line: `${settings.lockWaiters} waiting`,
        },
  );
  out.push(
    "unread" in reading.disk
      ? {
          gauge: "disk",
          fill: null,
          reads: reading.disk.unread,
          line: `${gib(settings.diskFreeBytes)} free`,
        }
      : {
          gauge: "disk",
          fill: aboveFloor(
            reading.disk.freeBytes,
            reading.disk.totalBytes,
            settings.diskFreeBytes,
          ),
          reads: `${gib(reading.disk.freeBytes)} free`,
          line: `${gib(settings.diskFreeBytes)} free`,
        },
  );
  out.push(
    "unread" in reading.forge || !(reading.forge.limit > 0)
      ? {
          gauge: "forge",
          fill: null,
          reads:
            "unread" in reading.forge
              ? reading.forge.unread
              : "the forge's budget has no limit",
          line: `${pct(settings.forgeFloor)} of the budget kept`,
        }
      : {
          gauge: "forge",
          fill: aboveFloor(
            reading.forge.remaining,
            reading.forge.limit,
            reading.forge.limit * settings.forgeFloor,
          ),
          reads: `${reading.forge.remaining} of ${reading.forge.limit} left`,
          line: `${pct(settings.forgeFloor)} of the budget kept`,
        },
  );
  const held = accounts.held + state.spentSlots;
  out.push({
    gauge: "accounts",
    fill: accounts.capacity === 0 ? 1 : held / accounts.capacity,
    reads: `${held} of ${accounts.capacity} slots held`,
    line: "no free slot",
  });
  return out;
}

/** The fullest gauge and its fill; `null` when none reads. */
export function factorOf(
  all: readonly LineLoadGauge[],
): { factor: number; binds: LoadGauge } | null {
  let top: { factor: number; binds: LoadGauge } | null = null;
  for (const g of all)
    if (g.fill !== null && (top === null || g.fill > top.factor))
      top = { factor: g.fill, binds: g.gauge };
  return top;
}

/** "82% · memory binds", or that no gauge read. */
export function factorText(load: Pick<LineLoad, "factor" | "binds">): string {
  return load.factor === null || load.binds === null
    ? "no gauge read"
    : `${Math.round(load.factor * 100)}% · ${load.binds} binds`;
}

/** Why a launch of `kind` does not fit now, naming the gauge; `null` when it fits. */
export function refusal(
  state: LoadState,
  kind: LoadKind,
): { gauge: LoadGauge; detail: string } | null {
  const own = reservation(state, kind);
  const reserve =
    kind === "pickup"
      ? Math.max(reservation(state, "drive"), reservation(state, "followup"))
      : 0;
  const mem = memory(state, own + reserve);
  if (mem !== null && mem.used > mem.usable)
    return {
      gauge: "memory",
      detail: `memory binds: ${gib(Math.max(0, mem.available - mem.floor))} is left above the ${gib(mem.floor)} kept free, and the ${kind} reserves ${gib(own)}${reserve > 0 ? ` and keeps ${gib(reserve)} for a drive or follow-up` : ""}`,
    };
  const all = gauges(state);
  for (const g of all) {
    if (g.fill === null || g.gauge === "memory") continue;
    if (g.gauge === "accounts") {
      // Account admission decides every launch; a pickup alone must also leave a slot free.
      if (kind !== "pickup") continue;
      const { held, capacity } = state.accounts;
      if (held + state.spentSlots + 1 < capacity) continue;
      return {
        gauge: "accounts",
        detail: `accounts bind: the pickup would take the last free slot (${g.reads}), which a drive or follow-up keeps`,
      };
    }
    if (g.gauge === "test-lock" && kind !== "pickup" && kind !== "drive")
      continue;
    if (g.fill >= 1)
      return {
        gauge: g.gauge,
        detail: `${g.gauge} binds: ${g.reads}, at its line of ${g.line}`,
      };
  }
  return null;
}

/**
 * Judge a launch of `kind` for `target`: `null` when it starts, its
 * reservation then counted for the rest of the tick; else the reason it
 * waits. A refused launch is recorded as a hold, and waits only under
 * enforcement; without it, it starts as it would have, uncounted, so the
 * holds the tick reports are the ones enforcement would make.
 */
export function judge(
  state: LoadState,
  kind: LoadKind,
  repo: string,
  target: string,
): string | null {
  const refused = refusal(state, kind);
  if (refused === null) {
    state.spentBytes += reservation(state, kind);
    state.spentSlots += 1;
    return null;
  }
  const held = state.settings.enforce;
  state.holds.push({
    repo,
    target,
    kind,
    gauge: refused.gauge,
    detail: refused.detail,
    held,
  });
  return held ? `the host's load holds it: ${refused.detail}` : null;
}

/** What the tick reports: the gauges as they were read, the load factor, the reservations and the holds. */
export function loadReport(state: LoadState): LineLoad {
  const read = gauges({ ...state, spentBytes: 0, spentSlots: 0 });
  const top = factorOf(read);
  return {
    enforce: state.settings.enforce,
    factor: top?.factor ?? null,
    binds: top?.binds ?? null,
    gauges: read,
    reservations: state.reservations,
    holds: state.holds,
  };
}

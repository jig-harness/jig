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
function reservationsOf(
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
function reservation(state: LoadState, kind: LoadKind): number {
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

/** A gauge's reading, or one the host gave none of. */
function gauge(
  name: LoadGauge,
  line: string,
  read: { fill: number; reads: string } | { unread: string },
): LineLoadGauge {
  return "unread" in read
    ? { gauge: name, fill: null, reads: read.unread, line }
    : { gauge: name, fill: read.fill, reads: read.reads, line };
}

function memoryGauge(state: LoadState): LineLoadGauge {
  const { settings, reading } = state;
  const mem = memory(state);
  const unread =
    reading.platform === "darwin"
      ? "memory not read on macOS, which reports no reclaimable memory"
      : "memory not read";
  return gauge(
    "memory",
    `${pct(settings.memoryFree)} of memory kept free`,
    mem === null
      ? { unread }
      : {
          fill: mem.used / mem.usable,
          reads: `${gib(mem.available)} available of ${gib(reading.totalBytes)}`,
        },
  );
}

function processorsGauge({ settings, reading }: LoadState): LineLoadGauge {
  const { load1, cores } = reading.host;
  const where =
    reading.platform === "win32"
      ? "Windows, which has no load average"
      : reading.platform;
  return gauge(
    "processors",
    `${settings.loadPerCore} per core`,
    load1 === null
      ? { unread: `processors not read on ${where}` }
      : {
          fill: load1 / cores / settings.loadPerCore,
          reads: `load ${load1.toFixed(1)} on ${cores} cores`,
        },
  );
}

function lockGauge({ settings, reading }: LoadState): LineLoadGauge {
  const lock = reading.lock;
  return gauge(
    "test-lock",
    `${settings.lockWaiters} waiting`,
    "unread" in lock
      ? lock
      : {
          fill: lock.waiters / settings.lockWaiters,
          reads: `${lock.holders} holding, ${lock.waiters} waiting`,
        },
  );
}

function diskGauge({ settings, reading }: LoadState): LineLoadGauge {
  const disk = reading.disk;
  return gauge(
    "disk",
    `${gib(settings.diskFreeBytes)} free`,
    "unread" in disk
      ? disk
      : {
          fill: aboveFloor(
            disk.freeBytes,
            disk.totalBytes,
            settings.diskFreeBytes,
          ),
          reads: `${gib(disk.freeBytes)} free`,
        },
  );
}

function forgeGauge({ settings, reading }: LoadState): LineLoadGauge {
  const forge = reading.forge;
  const line = `${pct(settings.forgeFloor)} of the budget kept`;
  if ("unread" in forge) return gauge("forge", line, forge);
  if (!(forge.limit > 0))
    return gauge("forge", line, { unread: "the forge's budget has no limit" });
  return gauge("forge", line, {
    fill: aboveFloor(
      forge.remaining,
      forge.limit,
      forge.limit * settings.forgeFloor,
    ),
    reads: `${forge.remaining} of ${forge.limit} left`,
  });
}

function accountsGauge(state: LoadState): LineLoadGauge {
  const { capacity } = state.accounts;
  const held = state.accounts.held + state.spentSlots;
  return gauge("accounts", "no free slot", {
    fill: capacity === 0 ? 1 : held / capacity,
    reads: `${held} of ${capacity} slots held`,
  });
}

/** Each gauge as the tick read it, with the launches it admitted counted. */
function gauges(state: LoadState): LineLoadGauge[] {
  return [
    memoryGauge(state),
    processorsGauge(state),
    lockGauge(state),
    diskGauge(state),
    forgeGauge(state),
    accountsGauge(state),
  ];
}

/** The fullest gauge and its fill; `null` when none reads. */
function factorOf(
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

type Refusal = { gauge: LoadGauge; detail: string };

/** Why the memory gauge refuses a launch of `kind`: its reservation, and for a pickup the reserve it keeps, past the floor. */
function memoryRefusal(state: LoadState, kind: LoadKind): Refusal | null {
  const own = reservation(state, kind);
  const reserve =
    kind === "pickup"
      ? Math.max(reservation(state, "drive"), reservation(state, "followup"))
      : 0;
  const mem = memory(state, own + reserve);
  if (mem === null || mem.used <= mem.usable) return null;
  const keeps =
    reserve > 0 ? ` and keeps ${gib(reserve)} for a drive or follow-up` : "";
  return {
    gauge: "memory",
    detail: `memory binds: ${gib(Math.max(0, mem.available - mem.floor))} is left above the ${gib(mem.floor)} kept free, and the ${kind} reserves ${gib(own)}${keeps}`,
  };
}

/** Why one of the other gauges refuses a launch of `kind`; `null` when it does not. */
function gaugeRefusal(
  state: LoadState,
  kind: LoadKind,
  g: LineLoadGauge,
): Refusal | null {
  if (g.fill === null || g.gauge === "memory") return null;
  if (g.gauge === "accounts") {
    // Account admission decides every launch; a pickup alone must also leave a slot free.
    const { held, capacity } = state.accounts;
    return kind === "pickup" && held + state.spentSlots + 1 >= capacity
      ? {
          gauge: "accounts",
          detail: `accounts bind: the pickup would take the last free slot (${g.reads}), which a drive or follow-up keeps`,
        }
      : null;
  }
  const lockExempt =
    g.gauge === "test-lock" && kind !== "pickup" && kind !== "drive";
  return !lockExempt && g.fill >= 1
    ? {
        gauge: g.gauge,
        detail: `${g.gauge} binds: ${g.reads}, at its line of ${g.line}`,
      }
    : null;
}

/** Why a launch of `kind` does not fit now, naming the gauge; `null` when it fits. */
function refusal(state: LoadState, kind: LoadKind): Refusal | null {
  const mem = memoryRefusal(state, kind);
  if (mem !== null) return mem;
  for (const g of gauges(state)) {
    const refused = gaugeRefusal(state, kind, g);
    if (refused !== null) return refused;
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

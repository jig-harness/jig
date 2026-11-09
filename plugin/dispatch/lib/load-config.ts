/**
 * The machine file's `load:` section: the line each of the host's gauges
 * must stay under, the memory each kind of launch reserves until its own
 * samples say otherwise, and whether the load factor holds launches or only
 * reports what it would hold (`load.ts`).
 *
 * ```yaml
 * load:
 *   enforce: false
 *   memory_free: 0.15     # share of the host's memory kept free after a launch
 *   load_per_core: 0.9    # one-minute load per core
 *   lock_waiters: 2       # runs waiting on the test lock
 *   disk_free_gb: 10      # free space on the workspaces' filesystem
 *   forge_floor: 0.1      # share of the forge's budget kept
 *   reservations_gb:      # until a kind has five samples of its own
 *     pickup: 2
 *     drive: 1.5
 *     followup: 1
 *     steward: 1
 * ```
 */
import { isMapping } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { LoadKind } from "./dashboard-contract.ts";

export const LOAD_KINDS: readonly LoadKind[] = [
  "pickup",
  "drive",
  "followup",
  "steward",
];

const GIB = 1024 ** 3;

export interface LoadSettings {
  /** Whether a launch a gauge refuses waits (`true`) or starts and is reported as one it would hold. */
  enforce: boolean;
  /** The share of the host's memory kept free after a launch's reservation. */
  memoryFree: number;
  /** The one-minute load per core the processors stay under. */
  loadPerCore: number;
  /** The runs waiting on the test lock at which no pickup or drive pass starts. */
  lockWaiters: number;
  /** The free bytes kept on the workspaces' filesystem. */
  diskFreeBytes: number;
  /** The share of the forge's budget kept. */
  forgeFloor: number;
  /** Each kind's reservation in bytes until it has samples enough of its own. */
  reservations: Record<LoadKind, number>;
}

export const LOAD_DEFAULTS: LoadSettings = {
  enforce: false,
  memoryFree: 0.15,
  loadPerCore: 0.9,
  lockWaiters: 2,
  diskFreeBytes: 10 * GIB,
  forgeFloor: 0.1,
  reservations: {
    pickup: 2 * GIB,
    drive: 1.5 * GIB,
    followup: 1 * GIB,
    steward: 1 * GIB,
  },
};

const KEYS = [
  "enforce",
  "memory_free",
  "load_per_core",
  "lock_waiters",
  "disk_free_gb",
  "forge_floor",
  "reservations_gb",
];

type Checked<T> = Outcome<T, "invalid">;

const invalid = (reason: string): Checked<never> => failed("invalid", reason);

function positive(
  value: unknown,
  where: string,
  fallback: number,
  below?: number,
): Checked<number> {
  if (value === undefined || value === null) return ok(fallback);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (below !== undefined && value >= below)
  )
    return invalid(
      `${where} must be a number above 0${below === undefined ? "" : ` and below ${below}`}`,
    );
  return ok(value);
}

function reservations(value: unknown): Checked<Record<LoadKind, number>> {
  const out = { ...LOAD_DEFAULTS.reservations };
  if (value === undefined || value === null) return ok(out);
  if (!isMapping(value))
    return invalid("load.reservations_gb must be a mapping");
  for (const [kind, gb] of Object.entries(value)) {
    if (!(LOAD_KINDS as readonly string[]).includes(kind))
      return invalid(
        `load.reservations_gb has an unknown kind: ${kind} (known: ${LOAD_KINDS.join(", ")})`,
      );
    const read = positive(gb, `load.reservations_gb.${kind}`, 0);
    if (!read.ok) return read;
    out[kind as LoadKind] = read.value * GIB;
  }
  return ok(out);
}

/** The `load:` section, every setting it leaves out at its default; an unknown key or a value out of range is refused. */
export function loadSettings(value: unknown): Checked<LoadSettings> {
  if (value === undefined || value === null) return ok(LOAD_DEFAULTS);
  if (!isMapping(value)) return invalid("load must be a mapping");
  const stray = Object.keys(value).find((key) => !KEYS.includes(key));
  if (stray !== undefined)
    return invalid(
      `load has an unknown key: ${stray} (known: ${KEYS.join(", ")})`,
    );
  const enforce = value.enforce ?? LOAD_DEFAULTS.enforce;
  if (typeof enforce !== "boolean")
    return invalid("load.enforce must be true or false");
  const memoryFree = positive(
    value.memory_free,
    "load.memory_free",
    LOAD_DEFAULTS.memoryFree,
    1,
  );
  if (!memoryFree.ok) return memoryFree;
  const loadPerCore = positive(
    value.load_per_core,
    "load.load_per_core",
    LOAD_DEFAULTS.loadPerCore,
  );
  if (!loadPerCore.ok) return loadPerCore;
  const lockWaiters = positive(
    value.lock_waiters,
    "load.lock_waiters",
    LOAD_DEFAULTS.lockWaiters,
  );
  if (!lockWaiters.ok) return lockWaiters;
  if (!Number.isSafeInteger(lockWaiters.value))
    return invalid("load.lock_waiters must be a positive whole number");
  const diskFreeGb = positive(
    value.disk_free_gb,
    "load.disk_free_gb",
    LOAD_DEFAULTS.diskFreeBytes / GIB,
  );
  if (!diskFreeGb.ok) return diskFreeGb;
  const forgeFloor = positive(
    value.forge_floor,
    "load.forge_floor",
    LOAD_DEFAULTS.forgeFloor,
    1,
  );
  if (!forgeFloor.ok) return forgeFloor;
  const reserved = reservations(value.reservations_gb);
  if (!reserved.ok) return reserved;
  return ok({
    enforce,
    memoryFree: memoryFree.value,
    loadPerCore: loadPerCore.value,
    lockWaiters: lockWaiters.value,
    diskFreeBytes: diskFreeGb.value * GIB,
    forgeFloor: forgeFloor.value,
    reservations: reserved.value,
  });
}

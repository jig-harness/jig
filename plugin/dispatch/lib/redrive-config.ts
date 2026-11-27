/**
 * How many times the tick re-drives a stop at one change before a person
 * settles it: a stall (exit `14`) and a spent CI-repair budget (exit `21`)
 * per head commit, a stop on a conflict per pair of head and base head. The
 * repository asks for a number (`dispatch.redrive.stalled`, `.conflict`,
 * `.ci`, each `1` when absent); the machine file's `redrive_max` (`1` when
 * absent) caps what any repository on the host may ask for, since the host
 * pays for the passes. `0` hands such a stop to a person at once. Every other
 * stop the tick re-drives is re-driven once per change, whatever these say.
 *
 * The tick writes the allowance on each such stop it reads (`withRedrives`),
 * where every reader of this host's launch records and another host's claims
 * finds it (`redrivesAllowed`).
 */
import { isMapping } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { unknownKeys } from "./overlap-config.ts";
import type { DrivenPr, StaleCause } from "./types.ts";

/** The re-drives per change of each kind of stop the configuration counts. */
export interface RedriveCounts {
  stalled: number;
  conflict: number;
  ci: number;
}

/** The re-drives per change when nothing sets them, and the host's cap when its file names none. */
const DEFAULT_REDRIVES = 1;

const KINDS = ["stalled", "conflict", "ci"] as const;

type Checked<T> = Outcome<T, "invalid">;

function invalid(reason: string): Checked<never> {
  return failed("invalid", reason);
}

/** A whole number, `0` or more, or the default when absent. */
function times(value: unknown, where: string): Checked<number> {
  if (value === undefined || value === null) return ok(DEFAULT_REDRIVES);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid(`${where} must be a whole number, 0 or more`);
  return ok(value);
}

/** `dispatch.redrive`: the repository's re-drives per change of each kind; absent when the section names none. */
export function redriveSection(
  value: unknown,
): Checked<RedriveCounts | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!isMapping(value)) return invalid("dispatch.redrive must be a mapping");
  const raw = value as Record<string, unknown>;
  const refused = unknownKeys("dispatch.redrive", raw, KINDS);
  if (refused !== null) return refused;
  const counts: RedriveCounts = { stalled: 1, conflict: 1, ci: 1 };
  for (const kind of KINDS) {
    const read = times(raw[kind], `dispatch.redrive.${kind}`);
    if (!read.ok) return read;
    counts[kind] = read.value;
  }
  return ok(counts);
}

/** The machine file's `redrive_max`: the most re-drives per change any repository on the host may ask for. */
export function redriveMax(value: unknown): Checked<number> {
  return times(value, "redrive_max");
}

/** What a repository's tick re-drives: what its section asks for, each kind capped by the host's `redrive_max`. */
export function redriveAllowanceOf(
  section: { redrive?: RedriveCounts | undefined },
  machine: { redriveMax?: number | undefined } | null | undefined,
): RedriveCounts {
  const cap = machine?.redriveMax ?? DEFAULT_REDRIVES;
  const asked = section.redrive;
  return {
    stalled: Math.min(asked?.stalled ?? DEFAULT_REDRIVES, cap),
    conflict: Math.min(asked?.conflict ?? DEFAULT_REDRIVES, cap),
    ci: Math.min(asked?.ci ?? DEFAULT_REDRIVES, cap),
  };
}

/** The kind of stop the configuration counts a stale stop's re-drives under; `null` for one re-driven once per change whatever it says. */
export function redriveKind(
  stale: StaleCause | undefined,
): keyof RedriveCounts | null {
  if (stale === undefined) return null;
  if (stale.conflictStop === true) return "conflict";
  if (stale.mechanicalStop === "stall") return "stalled";
  if (stale.mechanicalStop === "ci-repair") return "ci";
  return null;
}

/** The re-drives a stale stop is allowed at the change it shows: the allowance the tick wrote on it, else once. */
export function redrivesAllowed(stale: StaleCause): number {
  return stale.redrives ?? DEFAULT_REDRIVES;
}

/**
 * Each drive with the allowance written on a stop the configuration counts;
 * left as it is where the allowance is the default, so a drive reads the
 * same whether or not the tick wrote one.
 */
export function withRedrives(
  drives: readonly DrivenPr[],
  allowance: RedriveCounts,
): DrivenPr[] {
  return drives.map((pr) => {
    const kind = redriveKind(pr.stale);
    if (pr.stale === undefined || kind === null) return pr;
    const allowed = allowance[kind];
    return allowed === DEFAULT_REDRIVES
      ? pr
      : { ...pr, stale: { ...pr.stale, redrives: allowed } };
  });
}

/**
 * A read-only look at a PR's stored drive state, for the sweeps that must not
 * contend with a driver for the state lock.
 */
import { readStateRow } from "./store.ts";
import { type DriveState, isUsableState } from "./schema.ts";

/**
 * Read a PR's state DIRECTLY — no `openStore`, no lock. This command is
 * read-only over lock state by design (see the module header); the same
 * reasoning extends to state: taking the state lock here would make a
 * diagnostic sweep a second writer contending with an actual driver.
 * `isUsableState` is the SAME shape predicate `store.read()` uses, so a
 * state this rejects is one `store.read()` would refuse too.
 */
export function readStateSnapshot(
  stateDir: string,
  pr: string,
): { ok: true; state: DriveState } | { ok: false } {
  try {
    const raw = readStateRow(stateDir, pr)?.text;
    if (raw === undefined) return { ok: false };
    const parsed: unknown = JSON.parse(raw);
    if (!isUsableState(parsed, Number.parseInt(pr, 10))) return { ok: false };
    return { ok: true, state: parsed };
  } catch {
    return { ok: false };
  }
}

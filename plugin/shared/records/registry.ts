/**
 * The records registry: every kind of record the plugin keeps, one entry
 * each. A record is what one process writes for another, or for a later run
 * of itself, to read back. For each kind the registry declares its medium,
 * the plugin file that writes it, where it lives (a path, or the hidden
 * markers it carries on the forge or tracker, or the drive state family or
 * the table it is), the schema version writers write now, and what the
 * record means to a reader that meets it. The entries are kept by medium
 * beside this file: `registry-machine.ts`, `registry-tree.ts` and
 * `registry-forge.ts` (the forge and the tracker), each entry of the shape
 * `registry-kind.ts` declares.
 *
 * The registry declares and `scripts/check-records-registry.ts` derives: the
 * gate fails a hidden-marker literal, a drive state-file family or a SQLite
 * table under `plugin/` that no entry here holds, and an entry whose marker,
 * family, table or owner the code no longer has. The view a person reads,
 * with each record's format and what keeps two writers apart, is
 * [plugin/RECORDS.md](../../RECORDS.md); the Jig Protocol's chapters on
 * hidden comment markers and on the follow-up claim are generated from it.
 *
 * A kind another design adds registers when it is built: the dispatch
 * board's `board_seen` table is a `table` entry beside the dispatcher's, and
 * its "became ready" and "left ready" rows are rows of the outcome log
 * (`dispatch-outcome`), not kinds of their own.
 */
import type { RecordKind } from "./registry-kind.ts";
import { FORGE, TRACKER } from "./registry-forge.ts";
import { DISPATCHER, DRIVE_STATE, MACHINE } from "./registry-machine.ts";
import { TREE } from "./registry-tree.ts";

export { NOT_RECORDS, type NotARecord } from "./not-records.ts";
export type { RecordKind } from "./registry-kind.ts";

/** Every kind of record the plugin keeps, on every medium. */
export const RECORD_KINDS: readonly RecordKind[] = [
  ...DRIVE_STATE,
  ...DISPATCHER,
  ...MACHINE,
  ...TREE,
  ...FORGE,
  ...TRACKER,
];

const BY_NAME = new Map(RECORD_KINDS.map((kind) => [kind.name, kind]));

/** The registered kind of that name. */
export function recordKind(name: string): RecordKind | undefined {
  return BY_NAME.get(name);
}

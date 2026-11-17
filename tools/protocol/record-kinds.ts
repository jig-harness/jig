/**
 * The table a claim's chapter renders its kinds of the records registry in:
 * each kind's name, medium, markers, version, key and meaning.
 */
import type { RecordKind } from "../../plugin/shared/records/registry.ts";
import { table } from "./markdown.ts";

const ticked = (text: string) => `\`${text}\``;

/** The kinds as one table, in the order given. */
export function recordKindsTable(kinds: readonly RecordKind[]): string {
  return table(
    ["Kind", "Medium", "Markers", "Version", "Key", "Meaning"],
    kinds.map((k) => [
      ticked(k.name),
      k.medium,
      (k.markers ?? []).map(ticked).join(", "),
      String(k.version),
      k.key === undefined ? "—" : ticked(k.key.source),
      k.meaning,
    ]),
  );
}

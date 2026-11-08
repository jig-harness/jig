/** Nonempty GitHub values that cannot be restored through a canonical facet assignment. */
import type { ResolvedFacet } from "../facets/config.ts";
import { fold } from "../facets/values.ts";
import type { Facet } from "../port.ts";
import { record, str } from "./read.ts";

type StoredValue = { field: string; value: string; numeric?: true };
export function unmappedStores(
  slots: ResolvedFacet[],
  values: StoredValue[],
  fromField: (slot: ResolvedFacet, values: StoredValue[]) => string | null,
  fieldName: (slot: ResolvedFacet) => string,
): Facet[] {
  return slots
    .filter(
      (s) =>
        values.some((v) => fold(v.field) === fold(fieldName(s))) &&
        fromField(s, values) === null,
    )
    .map((s) => s.facet);
}
export function unmappedNativeType(
  slot: ResolvedFacet | null,
  raw: Record<string, unknown>,
  value: string | null | undefined,
): boolean {
  return slot?.store === "native" && raw.issueType != null && value === null;
}
export function nativeTypeName(
  raw: Record<string, unknown>,
  key: string,
): string | null {
  const t = raw.issueType;
  return t == null
    ? null
    : str(
        record(t, `issue ${key}.issueType`).name,
        `issue ${key}.issueType.name`,
      );
}

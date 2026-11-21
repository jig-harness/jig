/** An observable dependency of an item pickup, relative to its configured forge or tracker. */
export type PickupCondition =
  | { kind: "pr-merged"; pr: number }
  | { kind: "item-closed"; item: string };

export function parsePickupPr(value: string): number | null {
  if (!/^#?[1-9][0-9]*$/.test(value)) return null;
  const pr = Number(value.replace(/^#/, ""));
  return Number.isSafeInteger(pr) ? pr : null;
}

export function readPickupCondition(value: unknown): PickupCondition | null {
  if (typeof value !== "object" || value === null) return null;
  if (
    "kind" in value &&
    value.kind === "pr-merged" &&
    "pr" in value &&
    typeof value.pr === "number" &&
    parsePickupPr(String(value.pr)) !== null
  )
    return { kind: value.kind, pr: value.pr };
  if (
    "kind" in value &&
    value.kind === "item-closed" &&
    "item" in value &&
    typeof value.item === "string" &&
    /^(?:#[1-9][0-9]*|[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)$/.test(value.item)
  )
    return { kind: value.kind, item: value.item.toUpperCase() };
  return null;
}

export function pickupConditionWords(condition: PickupCondition): string {
  return condition.kind === "pr-merged"
    ? `PR #${condition.pr} to merge`
    : `${condition.item} to close`;
}

// expect: 3
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isObject(v: unknown): v is object {
  return typeof v === "object" && v !== null;
}
export const asRecord = (v: unknown) => (isObject(v) ? v : undefined);

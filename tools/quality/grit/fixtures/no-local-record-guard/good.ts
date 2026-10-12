// expect: 0
export function isRecordKey(v: unknown): v is string {
  return typeof v === "string";
}
export const isObjectLike = (v: unknown) => typeof v === "object";

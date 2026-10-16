// expect: 0
export function a(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RangeError) return "range";
    if ((e as { code?: string }).code === "ENOENT") return "missing";
    throw e;
  }
}
// Outside a catch clause a message is not a caught error's.
export const warnings = (events: { message: string }[]) =>
  events.filter((ev) => ev.message.startsWith("warn"));
export function describe(e: Error): string {
  return e.message === "" ? "(no message)" : e.message;
}
export const settled = (p: Promise<void>) =>
  p.catch((e: Error) => (e.message.includes("x") ? "x" : "other"));

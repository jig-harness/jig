// expect: 20
type Failure = { message: string; code?: string };
export function a(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    const err = e as Failure;
    if (err.message.includes("x")) return "includes";
    if (err.message.startsWith("x")) return "startsWith";
    if (err.message.endsWith("x")) return "endsWith";
    if (err.message === "x") return "equal";
    if ("x" !== err.message) return "unequal";
    if (/x/.test(err.message)) return "regex";
    if (err.message.toLowerCase().includes("x")) return "folded";
    if (err.message.match(/x/)) return "match";
    if (err.message.indexOf("x") >= 0) return "indexOf";
    if (err.message?.indexOf("x")) return "indexOf, optional call";
    if (err.message == "x") return "loose equal";
    if (e instanceof Error && /x/i.test(e.message)) return "guarded";
  }
  return "";
}
export function b(fn: () => void, maybe?: Failure): string {
  try {
    fn();
  } catch {
    if (maybe?.message.startsWith("x")) return "optional";
    if (maybe?.message === "x") return "optional equal";
    if (maybe?.message !== "x") return "optional unequal";
    if (maybe?.message == "x") return "optional loose equal";
    if ("x" != maybe?.message) return "optional loose unequal";
    if (maybe?.message.indexOf("x")) return "optional indexOf";
    if (maybe?.message?.search(/x/)) return "optional search";
    // An unrelated object's message, inside a catch clause, is flagged too.
    const events = [{ message: "warn: x" }];
    return events.filter((ev) => ev.message.startsWith("warn")).length
      ? "unrelated"
      : "";
  }
  return "";
}

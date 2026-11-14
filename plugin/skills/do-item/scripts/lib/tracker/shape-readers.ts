/** Shared response primitives retain each adapter's own error type and messages. */
import { isRecord } from "../../../../../shared/guards.ts";
import { parseMs } from "../../../../../shared/time.ts";

export function shapeReaders(fail: (message: string) => Error) {
  function record(v: unknown, where: string): Record<string, unknown> {
    if (!isRecord(v)) throw fail(`${where}: expected an object`);
    return v;
  }

  function str(v: unknown, where: string): string {
    if (typeof v !== "string") throw fail(`${where}: expected a string`);
    return v;
  }

  function optStr(v: unknown, where: string): string | null {
    return v === null || v === undefined ? null : str(v, where);
  }

  function timestamp(v: unknown, where: string): string {
    const s = str(v, where);
    if (!Number.isFinite(parseMs(s))) throw fail(`${where}: not a timestamp`);
    return s;
  }

  function optTimestamp(v: unknown, where: string): string | null {
    return v === null ? null : timestamp(v, where);
  }

  return { record, str, optStr, timestamp, optTimestamp };
}

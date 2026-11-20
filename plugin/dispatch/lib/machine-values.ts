/** Scalar and list readers used by the dispatcher's machine configuration. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

export type Checked<T> = Outcome<T, "invalid">;

export function invalid(reason: string): Checked<never> {
  return failed("invalid", reason);
}

export function only(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
): Checked<true> {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  return unknown.length > 0
    ? invalid(
        `${where} has unknown key(s): ${unknown.join(", ")} (known: ${allowed.join(", ")})`,
      )
    : ok(true);
}

export function text(value: unknown, where: string): Checked<string> {
  if (typeof value !== "string" || value.trim() === "")
    return invalid(`${where} must be a nonempty string`);
  return ok(value.trim());
}

export function count(
  value: unknown,
  where: string,
  fallback: number,
): Checked<number> {
  if (value === undefined || value === null) return ok(fallback);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return invalid(`${where} must be a positive whole number`);
  return ok(value);
}

export function list(value: unknown, where: string): Checked<unknown[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return invalid(`${where} must be a list`);
  return ok(value);
}

export function each<T>(
  items: unknown[],
  read: (item: unknown, i: number) => Checked<T>,
): Checked<T[]> {
  const out: T[] = [];
  for (const [i, item] of items.entries()) {
    const one = read(item, i);
    if (!one.ok) return one;
    out.push(one.value);
  }
  return ok(out);
}

export function flag(
  value: unknown,
  where: string,
  fallback: boolean,
): Checked<boolean> {
  if (value === undefined || value === null) return ok(fallback);
  if (typeof value !== "boolean")
    return invalid(`${where} must be true or false`);
  return ok(value);
}

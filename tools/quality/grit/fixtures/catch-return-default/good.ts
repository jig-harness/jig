// expect: 0
import { readFileSync } from "node:fs";
export function bound(): string | null {
  try {
    return readFileSync("x", "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}
export function rethrows(): string {
  try {
    return readFileSync("x", "utf8");
  } catch {
    throw new Error("x is unreadable");
  }
}
export function valueReturned(): string {
  try {
    return readFileSync("x", "utf8");
  } catch {
    return "fallback";
  }
}

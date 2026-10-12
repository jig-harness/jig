// expect: 4
import { readFileSync } from "node:fs";
export function a(): string | null {
  try {
    return readFileSync("x", "utf8");
  } catch {
    return null;
  }
}
export function b(): boolean {
  try {
    readFileSync("x");
    return true;
  } catch {
    return false;
  }
}
export function c(): string[] {
  try {
    return [readFileSync("x", "utf8")];
  } catch {
    return [];
  }
}
export function d(): string | undefined {
  try {
    return readFileSync("x", "utf8");
  } catch (_error) {
    return undefined;
  }
}

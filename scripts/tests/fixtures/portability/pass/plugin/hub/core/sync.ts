// Portable: relative imports only, a type-only import of a runtime module,
// names that are properties or keys, and a parameter named `process`.
import type { Stats } from "node:fs";
import type { Shape } from "../../shared/shape.ts";
import { helper } from "../../shared/helper.ts";
export type { Loader } from "../../shared/loader-types.ts";

export function sync(stats: Stats | null, shape: Shape): number {
  const labels = { Bun: 1, Deno: 2 };
  const job = { process: "sweep" };
  return helper(job.process.length + labels.Bun + (stats ? 1 : 0) + shape.size);
}

export function step(process: string): string {
  return `${process} at ${import.meta.url}`;
}

export const later = () => import("./later.ts");

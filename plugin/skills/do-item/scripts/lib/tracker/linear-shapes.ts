/** Defensive readers for Linear response values and bounded label pages. */
import { isRecord } from "../../../../../shared/guards.ts";
import { shapeReaders } from "./shape-readers.ts";
import type { IssueState } from "./port.ts";

export class ShapeError extends Error {}

export const { record, str, optStr, timestamp, optTimestamp } = shapeReaders(
  (message) => new ShapeError(message),
);

/** Does the connection positively say there is no next page? */
export function complete(conn: Record<string, unknown>): boolean {
  return isRecord(conn.pageInfo) && conn.pageInfo.hasNextPage === false;
}

/**
 * Label names off a label connection. Strict: a missing or truncated
 * connection read as "no labels" would silently erase an epic attribution.
 */
export function labelNames(v: unknown, where: string): string[] {
  if (!isRecord(v) || !Array.isArray(v.nodes))
    throw new ShapeError(`${where}: labels connection missing or malformed`);
  if (!complete(v))
    throw new ShapeError(
      `${where}: labels list is truncated or its pageInfo is unreadable`,
    );
  return v.nodes.map((n) => {
    if (!isRecord(n) || typeof n.name !== "string")
      throw new ShapeError(`${where}: a label node is malformed`);
    return n.name;
  });
}

/** A label page that may have more: its names, and whether it had more. */
export function labelPage(
  v: unknown,
  where: string,
): { names: string[]; truncated: boolean } {
  const labels = record(v, `${where}.labels`);
  if (!Array.isArray(labels.nodes))
    throw new ShapeError(`${where}.labels: nodes missing`);
  const info = labels.pageInfo;
  if (!isRecord(info) || typeof info.hasNextPage !== "boolean")
    throw new ShapeError(`${where}.labels.pageInfo: unreadable`);
  return {
    names: labels.nodes.map((l) =>
      str(record(l, `${where}.labels[]`).name, `${where}.labels[].name`),
    ),
    truncated: info.hasNextPage,
  };
}

/** A priority Linear reports: an integer, 0 (none) to 4 (low). */
export function priorityOf(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 4)
    throw new ShapeError(`${where}.priority: expected an integer 0 to 4`);
  return v;
}
export function stateOf(v: unknown, where: string): IssueState {
  const s = record(v, where);
  return {
    name: typeof s.name === "string" ? s.name : "",
    type: typeof s.type === "string" ? s.type : "",
  };
}

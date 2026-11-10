/**
 * `retireSteers`: a machine entry that does not enable `steer` still retires
 * the nudge rows the observed tick no longer plans, and sends nothing.
 */
import { describe, expect, it } from "bun:test";
import { retireSteers } from "../lib/actions/steer.ts";
import type { ActionBook } from "../lib/failures.ts";
import type { RepoReport } from "../lib/types.ts";

function bookOf(calls: [string, string[]][]): ActionBook {
  return {
    wanted: (kind: string, keys: string[]) => {
      calls.push([kind, [...keys]]);
    },
  } as unknown as ActionBook;
}

const report = { actions: [] } as unknown as RepoReport;

describe("retireSteers", () => {
  it("names no wanted nudge when the tick observed and planned none", () => {
    const calls: [string, string[]][] = [];
    retireSteers(report, bookOf(calls), true);
    expect(calls).toEqual([["nudge", []]]);
  });

  it("leaves the rows alone when the session listing did not read", () => {
    const calls: [string, string[]][] = [];
    retireSteers(report, bookOf(calls), false);
    expect(calls).toEqual([]);
  });

  it("does nothing without a book", () => {
    expect(() => retireSteers(report, null, true)).not.toThrow();
  });
});

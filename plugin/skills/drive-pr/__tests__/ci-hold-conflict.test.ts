import { describe, expect, it } from "bun:test";
import { reportsConflict } from "../scripts/lib/ci-hold.ts";

const answer = (stdout: string, code = 0) => ({ code, stdout });

describe("reportsConflict", () => {
  it("reads only GitHub's CONFLICTING verdict as a conflict", () => {
    expect(reportsConflict(answer('{"mergeable":"CONFLICTING"}\n'))).toBe(true);
    for (const verdict of ["MERGEABLE", "UNKNOWN", "conflicting"])
      expect(
        reportsConflict(answer(JSON.stringify({ mergeable: verdict }))),
      ).toBe(false);
  });

  it("fails closed on a call that failed or an answer it cannot read", () => {
    expect(reportsConflict(answer('{"mergeable":"CONFLICTING"}', 1))).toBe(
      false,
    );
    for (const stdout of ["", "not json", "null", "[]", '{"mergeable":null}'])
      expect(reportsConflict(answer(stdout))).toBe(false);
  });
});

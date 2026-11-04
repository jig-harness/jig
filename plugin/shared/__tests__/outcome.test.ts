/**
 * Failures are values: `attempt` turns what an I/O edge throws into a failure
 * with a stable code and a reason for a person, keeping what was thrown.
 */
import { describe, expect, it } from "bun:test";
import { attempt, failed, ok } from "../outcome.ts";

class FixtureError extends Error {}

describe("Outcome", () => {
  it("carries the value a read returns", () => {
    expect(attempt("read-failed", "the file cannot be read", () => 7)).toEqual(
      ok(7),
    );
  });

  it("turns what a read throws into a failure with its code, its reason and its cause", () => {
    const thrown = new FixtureError("no such file");
    const outcome = attempt("read-failed", "the file cannot be read", () => {
      throw thrown;
    });
    expect(outcome).toEqual({
      ok: false,
      failure: {
        code: "read-failed",
        reason: "the file cannot be read: no such file",
        cause: thrown,
      },
    });
  });

  it("states a thrown value that is not an error", () => {
    const outcome = attempt("read-failed", "the file cannot be read", () => {
      throw "a bare string";
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.failure.reason).toBe(
        "the file cannot be read: a bare string",
      );
  });

  it("leaves the cause out of a failure that has none", () => {
    expect(failed("no-receipt", "nothing yet")).toEqual({
      ok: false,
      failure: { code: "no-receipt", reason: "nothing yet" },
    });
  });
});

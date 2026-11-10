/**
 * The preflight command: its setting, and how its exit code and standard
 * output become a proceed or a refusal.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { preflightCommandOf, runPreflight } from "../scripts/lib/preflight.ts";

const ROOT = process.cwd();
const ISSUE = JSON.stringify({ found: true, identifier: "#5" });

afterEach(() => {
  delete process.env.JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC;
});

describe("preflightCommandOf", () => {
  it("is null when the repository sets none", () => {
    expect(preflightCommandOf(null)).toBeNull();
    expect(preflightCommandOf({})).toBeNull();
    expect(preflightCommandOf({ do_item: {} })).toBeNull();
    expect(
      preflightCommandOf({ do_item: { preflight_command: null } }),
    ).toBeNull();
  });

  it("returns the command", () => {
    expect(
      preflightCommandOf({ do_item: { preflight_command: "check" } }),
    ).toBe("check");
  });

  it("refuses a value that is not a nonempty string", () => {
    for (const value of ["", "  ", 5, ["a"], {}])
      expect(() =>
        preflightCommandOf({ do_item: { preflight_command: value } }),
      ).toThrow("do_item.preflight_command");
  });
});

describe("runPreflight", () => {
  it("proceeds on exit 0", async () => {
    expect(await runPreflight(ROOT, "exit 0", ISSUE)).toEqual({
      outcome: "proceed",
    });
  });

  it("gives the command the issue on standard input", async () => {
    const answer = await runPreflight(
      ROOT,
      `grep -q '"identifier":"#5"' || { echo not seen; exit 3; }`,
      ISSUE,
    );
    expect(answer).toEqual({ outcome: "proceed" });
  });

  it("refuses on exit 3 with the first line of standard output", async () => {
    expect(
      await runPreflight(ROOT, "echo 'other repo'; echo more; exit 3", ISSUE),
    ).toEqual({ outcome: "refused", kind: "refused", reason: "other repo" });
  });

  it("refuses on exit 3 without output, saying it gave no reason", async () => {
    const answer = await runPreflight(ROOT, "exit 3", ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", kind: "refused" });
    expect(answer.outcome === "refused" && answer.reason).toContain(
      "giving no reason",
    );
  });

  it("keeps a long reason to one bounded line", async () => {
    const answer = await runPreflight(
      ROOT,
      `printf 'a%.0s' $(seq 1 1000); exit 3`,
      ISSUE,
    );
    expect(answer.outcome === "refused" && answer.reason.length).toBeLessThan(
      400,
    );
  });

  it("refuses on any other exit, with the tail of its error output", async () => {
    const answer = await runPreflight(ROOT, "echo broke >&2; exit 2", ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", kind: "failed" });
    expect(answer.outcome === "refused" && answer.reason).toContain(
      "failed (exit 2: broke)",
    );
  });

  it("refuses a command that is still running at the deadline", async () => {
    process.env.JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC = "1";
    const answer = await runPreflight(ROOT, "exec sleep 30", ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", kind: "failed" });
    expect(answer.outcome === "refused" && answer.reason).toContain(
      "still running after 1s",
    );
  });

  it("refuses a command that cannot start", async () => {
    const answer = await runPreflight("/nonexistent-dir-743", "exit 0", ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", kind: "failed" });
  });
});

import { describe, expect, test } from "bun:test";
import { orcaAnswering } from "../../../lib/test-helpers/orca-answering.ts";
import {
  currentWorktree,
  orcaCommand,
  orcaEnvelope,
  orcaFailure,
  orcaResult,
  orcaTabCommand,
} from "../orca.ts";

const ORCA = { ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };

describe("orcaCommand", () => {
  test("comes from its terminal's environment only", () => {
    expect(orcaCommand({})).toBeNull();
    expect(orcaCommand({ ORCA_CLI_BIN_DIR: "/opt/orca/bin" }, "darwin")).toBe(
      "/opt/orca/bin/orca",
    );
    expect(orcaCommand({ ORCA_CLI_BIN_DIR: "/opt/orca/bin" }, "linux")).toBe(
      "/opt/orca/bin/orca-ide",
    );
    expect(orcaCommand({ ...ORCA, ORCA_CLI_BIN_DIR: "/elsewhere" })).toBe(
      "/opt/orca/bin/orca",
    );
  });
});

describe("orcaTabCommand", () => {
  test("is Orca's command when the harness runs under Orca", () => {
    expect(orcaTabCommand({ ...ORCA, CLAUDECODE: "1" })).toBe(
      "/opt/orca/bin/orca",
    );
  });

  test("is null outside Orca, and under another wrapper", () => {
    expect(orcaTabCommand({ CLAUDECODE: "1" })).toBeNull();
    expect(orcaTabCommand({ ...ORCA, HERDR_ENV: "1" })).toBeNull();
  });

  test("is null under Orca when Orca named no command", () => {
    expect(orcaTabCommand({ ORCA_VERSION: "1.0.0" })).toBeNull();
  });
});

describe("the JSON envelope", () => {
  test("a successful call's result", () => {
    const stdout = JSON.stringify({ ok: true, result: { terminal: {} } });
    expect(orcaResult({ code: 0, stdout })).toEqual({ terminal: {} });
    expect(orcaResult({ code: 1, stdout })).toBeNull();
  });

  test("a refused call's error code", () => {
    const stdout = JSON.stringify({
      ok: false,
      error: { code: "selector_not_found" },
    });
    expect(orcaEnvelope(stdout)).toEqual({
      ok: false,
      code: "selector_not_found",
    });
    expect(orcaResult({ code: 0, stdout })).toBeNull();
  });

  test("output that is not Orca's has no envelope", () => {
    expect(orcaEnvelope("not json")).toBeNull();
    expect(orcaEnvelope("[]")).toBeNull();
    expect(
      orcaFailure({ code: 127, stdout: "", stderr: "orca: not found\n" }),
    ).toBe("(exit 127): orca: not found");
  });
});

describe("currentWorktree", () => {
  const CURRENT = "worktree current --json";
  const answer = (worktree: unknown) =>
    JSON.stringify({ ok: true, result: { worktree } });

  test("reads the id and the link, null when absent", async () => {
    const linked = orcaAnswering({
      [CURRENT]: answer({ id: "w", linkedPR: 7 }),
    });
    expect(await currentWorktree("orca", linked.runner)).toEqual({
      id: "w",
      linkedPR: 7,
    });
    const bare = orcaAnswering({ [CURRENT]: answer({ id: "w" }) });
    expect(await currentWorktree("orca", bare.runner)).toEqual({
      id: "w",
      linkedPR: null,
    });
  });

  test("warns on a link that is neither a string, a number nor null", async () => {
    const { runner } = orcaAnswering({
      [CURRENT]: answer({ id: "w", linkedPR: { toString: null } }),
    });
    expect(await currentWorktree("orca", runner)).toEqual({
      warning: "⚠ Orca answered a link that is not a pull request number",
    });
  });

  test("answers none only for the not-a-worktree code", async () => {
    const { runner } = orcaAnswering({
      [CURRENT]: JSON.stringify({
        ok: false,
        error: { code: "selector_not_found" },
      }),
    });
    expect(await currentWorktree("orca", runner)).toBe("none");
  });
});

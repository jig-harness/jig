/**
 * The harness a script runs under, read from the variables it and its
 * wrapper set.
 */
import { describe, expect, it } from "bun:test";
import { detectHarness } from "../harness.ts";

describe("detectHarness", () => {
  it("detects the harness and its wrapper from their variables", () => {
    expect(
      detectHarness({
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CONDUCTOR_PORT: "1",
      }),
    ).toEqual({
      name: "claude-code",
      version: null,
      entrypoint: "cli",
      wrapper: "conductor",
    });
    expect(detectHarness({ HERDR_ENV: "1", CODEX_HOME: "/x" })).toEqual({
      name: "codex",
      version: null,
      entrypoint: null,
      wrapper: "herdr",
    });
    expect(
      detectHarness({ CLAUDECODE: "1", ORCA_WORKTREE_ID: "r::/w" }),
    ).toEqual({
      name: "claude-code",
      version: null,
      entrypoint: null,
      wrapper: "orca",
    });
    expect(detectHarness({ ORCA_PANE_KEY: "t:p" })).toEqual({
      name: null,
      version: null,
      entrypoint: null,
      wrapper: "orca",
    });
    expect(detectHarness({ HERDR_ENV: "0" })).toBeNull();
    expect(detectHarness({ PATH: "/bin" })).toBeNull();
  });
});

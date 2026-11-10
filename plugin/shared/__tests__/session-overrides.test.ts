/** Configuration forwarding across a terminal with its own environment. */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { exceptOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { shellQuote } from "../cli.ts";
import { DROP_LOGIN_FIELDS, sessionOverrides } from "../session-overrides.ts";

const LOGIN_PREFIX = ["sh", "-c", DROP_LOGIN_FIELDS, "sh", "env"];

describe("the configuration the tab reads", () => {
  it("carries the field overrides and the layer selectors, a path selector made absolute", () => {
    const env = {
      JIG__DRIVE__PASS_MODEL: "opus",
      JIG_OVERLAY: "scratch/jig.yaml",
      JIG_HOME: "/home/me/.jig-alt",
      JIG_USER_LAYER: "off",
      JIG_OTHER: "ignored",
      HOME: "/home/me",
    };
    expect(sessionOverrides(env, "/work/tree")).toEqual([
      ...LOGIN_PREFIX,
      "JIG__DRIVE__PASS_MODEL=opus",
      `JIG_OVERLAY=${resolve("/work/tree", "scratch/jig.yaml")}`,
      `JIG_HOME=${resolve("/work/tree", "/home/me/.jig-alt")}`,
      "JIG_USER_LAYER=off",
    ]);
  });

  it("carries a blank selector as blank, so the login shell cannot fill it", () => {
    expect(
      sessionOverrides(
        { JIG_OVERLAY: "", JIG_HOME: " ", JIG_USER_LAYER: "", HOME: "/h" },
        "/w",
      ),
    ).toEqual([
      ...LOGIN_PREFIX,
      "JIG_OVERLAY=",
      "JIG_HOME= ",
      "JIG_USER_LAYER=",
    ]);
  });

  it("unsets a selector the session leaves unset", () => {
    expect(sessionOverrides({ HOME: "/h" }, "/w")).toEqual([
      ...LOGIN_PREFIX,
      "-u",
      "JIG_HOME",
      "-u",
      "JIG_OVERLAY",
      "-u",
      "JIG_USER_LAYER",
    ]);
  });

  it("reads back, in a shell whose profile exports configuration, the session's and nothing else", () => {
    const argv = [
      ...sessionOverrides({ JIG__A: "kept", JIG_OVERLAY: "" }, "/w"),
      "sh",
      "-c",
      'echo "$JIG__A|$JIG__B|[$JIG_OVERLAY]|[$JIG_HOME]"',
    ];
    expect(argv).toContain("JIG__A=kept");
    exceptOnWindows("the tab's shell is POSIX", () => {
      const line = argv.map(shellQuote).join(" ");
      const done = Bun.spawnSync(["sh", "-c", line], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          JIG__A: "profile",
          JIG__B: "profile",
          JIG_OVERLAY: "/other/jig.yaml",
          JIG_HOME: "/other",
        },
      });
      expectSpawnExit(
        { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr },
        0,
        "sh",
      );
      expect(done.stdout.toString().trim()).toBe("kept||[]|[]");
    });
  });

  it("removes the Electron controls a terminal's own environment carries", () => {
    const argv = [
      ...sessionOverrides({ HOME: "/h" }, "/w"),
      "sh",
      "-c",
      'echo "[$ELECTRON_RUN_AS_NODE][$ELECTRON_CRASH_REPORTER][$CHROME_CRASHPAD_PIPE_NAME][$KEEP]"',
    ];
    exceptOnWindows("the tab's shell is POSIX", () => {
      const line = argv.map(shellQuote).join(" ");
      const done = Bun.spawnSync(["sh", "-c", line], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_CRASH_REPORTER: "x",
          CHROME_CRASHPAD_PIPE_NAME: "pipe",
          KEEP: "yes",
        },
      });
      expectSpawnExit(
        { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr },
        0,
        "sh",
      );
      expect(done.stdout.toString().trim()).toBe("[][][][yes]");
    });
  });
});

/** The drive and shared callers bind one cache implementation to their own process transports. */
import { describe, expect, it } from "bun:test";
import * as shared from "../../../shared/gh-conditional.ts";
import * as drive from "../scripts/lib/gh-conditional.ts";
import { createConditionalCache } from "../../../shared/gh-conditional.ts";

describe("shared conditional cache", () => {
  it("exposes the same API to the drive and other skills", () => {
    expect(Object.keys(drive).sort()).toEqual(
      Object.keys(shared)
        .filter((key) => key !== "createConditionalCache")
        .sort(),
    );
    expect(drive.ghCacheDir()).toBe(shared.ghCacheDir());
    expect(typeof drive.cachedRepoView).toBe("function");
  });

  it("retains each caller's process transport without sharing bindings", async () => {
    const calls: string[][] = [];
    const makeCache = (name: string) =>
      createConditionalCache({
        ghCall: async (args) => {
          calls.push([name, ...args]);
          return {
            code: 0,
            stdout: name,
            stderr: "",
            stderrTail: "",
            bufferExceeded: false,
            timedOut: false,
            spawnFailed: false,
          };
        },
        git: async () => {
          throw new Error("a disabled cache must not resolve repository scope");
        },
      });
    const first = makeCache("first");
    const second = makeCache("second");
    expect((await first.cachedRepoView(["--json", "name"])).stdout).toBe(
      "first",
    );
    expect((await second.cachedRepoView(["--json", "name"])).stdout).toBe(
      "second",
    );
    expect(calls).toEqual([
      ["first", "repo", "view", "--json", "name"],
      ["second", "repo", "view", "--json", "name"],
    ]);
  });
});

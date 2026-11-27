/**
 * A fixed batch's pass decides whether a member whose priority was cleared
 * after the tick may start with the `dispatch.missing_priority` the
 * dispatcher read from the default branch, carried by the launch as
 * `--missing-priority`, never with the workspace's own configuration, which
 * nobody reviewed. Each run is a child process whose working directory is a
 * workspace that sets `start`.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { OVERLAY } from "./helpers.ts";

const child = join(import.meta.dir, "fixtures", "fixed-batch-main.ts");
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A workspace whose configuration lets an item with no priority start. */
function startingWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "work-batch-policy-"));
  scratch.push(dir);
  mkdirSync(join(dir, ".config"));
  const config = { ...OVERLAY, dispatch: { missing_priority: "start" } };
  // JSON is YAML: the file holds the test's configuration as it is.
  writeFileSync(join(dir, ".config", "jig.yaml"), JSON.stringify(config));
  return dir;
}

/** The child's environment: no configuration but the workspace's file. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith("JIG__") &&
      !["JIG_OVERLAY", "JIG_CONSUMER_ROOT"].includes(k)
    )
      env[k] = v;
  return env;
}

/** The proposal for the fixed members, with the launch's policy when given. */
function propose(policy?: string) {
  const result = Bun.spawnSync(
    [
      "bun",
      child,
      "ENG-1",
      "--fixed",
      "ENG-1,ENG-2",
      ...(policy === undefined ? [] : ["--missing-priority", policy]),
      "--format",
      "json",
    ],
    {
      cwd: startingWorkspace(),
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expectSpawnExit(result, 0, "candidates.ts");
  return JSON.parse(result.stdout.toString()) as {
    candidates: unknown[];
    alone?: {
      missingPriority: string;
      claim: string | null;
      heldForPriority: string[];
    };
  };
}

describe("a fixed batch whose members lost their priority, in a workspace set to start them", () => {
  it("starts none when the default branch the dispatcher read holds them", () => {
    const p = propose("hold");
    expect(p.candidates).toEqual([]);
    expect(p.alone).toEqual({
      missingPriority: "hold",
      claim: null,
      heldForPriority: ["ENG-1", "ENG-2"],
    });
  });

  it("starts none when the launch named no policy, the dispatcher's own default", () => {
    expect(propose().alone?.claim).toBeNull();
  });

  it("starts the first when the default branch says start", () => {
    expect(propose("start").alone?.claim).toBe("ENG-1");
  });
});

describe("--missing-priority", () => {
  it("is refused outside a fixed batch, and for a value it does not know", () => {
    for (const args of [
      ["ENG-1", "--missing-priority", "hold"],
      ["ENG-1", "--fixed", "ENG-1", "--missing-priority", "later"],
    ]) {
      const result = Bun.spawnSync(["bun", child, ...args], {
        cwd: startingWorkspace(),
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(result, 2, args.join(" "));
    }
  });
});

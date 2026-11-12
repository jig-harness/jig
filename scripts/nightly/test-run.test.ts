// `bun run test` on the nightly run, end to end: scripts/test.ts spawned on a
// fixture suite with the nightly's variables set, as the workflow sets them.
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { platformName } from "./baseline.ts";
import { Tail } from "./capture-output.ts";

const SCRIPT = join(import.meta.dir, "..", "test.ts");
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

const SUITE = `import { describe, expect, test } from "bun:test";
describe("outer", () => {
  test("known to fail", () => expect(1).toBe(2));
  test("recorded, now passing", () => expect(1).toBe(1));
  test("never sees the nightly's variables", () =>
    expect(Object.keys(process.env).filter((k) => k.startsWith("JIG_NIGHTLY_"))).toEqual([]));
});
`;

const BASELINE = `version: 1
groups:
  - platform: ${platformName()}
    issue: "#7"
    reason: The fixture fails on purpose.
    tests:
      suite.test.ts:
        - "outer > known to fail"
        - "outer > recorded, now passing"
`;

/** A fixture suite with `extra` files, run through scripts/test.ts with the nightly's variables unless `nightly` is false. */
function run(extra: Record<string, string>, nightly = true) {
  const root = mkdtempSync(join(tmpdir(), "jig-nightly-run-"));
  temporary.push(root);
  writeFileSync(join(root, "suite.test.ts"), SUITE);
  writeFileSync(join(root, "baseline.yaml"), BASELINE);
  for (const [name, content] of Object.entries(extra))
    writeFileSync(join(root, name), content);
  const results = join(root, "results");
  const summary = join(root, "summary.md");
  const env: Record<string, string | undefined> = {
    ...process.env,
    RESOURCE_LOCK_BYPASS: "1",
  };
  if (nightly)
    Object.assign(env, {
      JIG_NIGHTLY_BASELINE: "baseline.yaml",
      JIG_NIGHTLY_RESULTS: results,
      JIG_NIGHTLY_JOB: "gates (fixture)",
      GITHUB_STEP_SUMMARY: summary,
    });
  const child = Bun.spawnSync([process.execPath, SCRIPT, "--parallel=1"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const files = nightly ? readdirSync(results) : [];
  return {
    child,
    result:
      files.length === 1
        ? JSON.parse(readFileSync(join(results, files[0] ?? ""), "utf8"))
        : undefined,
    summary: nightly ? readFileSync(summary, "utf8") : "",
  };
}

describe("bun run test on the nightly run", () => {
  test("a suite that fails only on recorded tests passes, and reports the recorded test that passed", () => {
    const { child, result, summary } = run({});
    expectSpawnExit(child, 0);
    expect(result).toMatchObject({
      job: "gates (fixture)",
      verdict: "known",
      status: 0,
      knownFailures: [{ file: "suite.test.ts", name: "outer > known to fail" }],
      stale: [
        {
          file: "suite.test.ts",
          name: "outer > recorded, now passing",
          issue: "#7",
        },
      ],
    });
    expect(child.stderr.toString()).toContain(
      "stale: suite.test.ts: outer > recorded, now passing passed",
    );
    expect(summary).toContain("Recorded failures that passed");
  });

  test("a failure the baseline does not record fails the run and is named", () => {
    const { child, result } = run({
      "other.test.ts":
        'import { test, expect } from "bun:test";\ntest("breaks tonight", () => expect(1).toBe(2));\n',
    });
    expectSpawnExit(child, 1);
    expect(result).toMatchObject({
      verdict: "new",
      newFailures: [{ file: "other.test.ts", name: "breaks tonight" }],
    });
    expect(child.stderr.toString()).toContain(
      "[nightly-new-failure] breaks tonight failed",
    );
  });

  test("a test file that fails to load fails the run, though every reported failure is recorded", () => {
    const { child, result } = run({
      "broken.test.ts": 'throw new Error("cannot load");\n',
    });
    expectSpawnExit(child, 1);
    expect(result).toMatchObject({ verdict: "unexplained", newFailures: [] });
    expect(result.detail).toMatch(/failed to load/);
  });

  test("without the nightly's variables, a recorded failure fails the run as before", () => {
    expectSpawnExit(run({}, false).child, 1);
  });

  test("the captured output keeps only its end", () => {
    const tail = new Tail(8);
    for (const part of ["abcdef", "ghij", "klm"])
      tail.push(new TextEncoder().encode(part));
    expect(tail.text()).toBe("fghijklm");
  });
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { stateInodeCheck } from "../../shared/fixture-health.ts";
import { readReceipt, receiptPaths } from "../receipts.ts";

test.each([
  [99, "fail"],
  [100, "pass"],
  [0, "fail"],
  [1000, "pass"],
] as const)(
  "state filesystem with %i of 1000 free inodes is %s",
  (ffree, status) => {
    const check = stateInodeCheck(() => ({ files: 1000, ffree }));
    expect(check).toMatchObject({
      id: "gc:state-inodes",
      status,
    });
    expect(check.detail).toContain("free inodes");
    if (status === "fail") {
      expect(check.detail).toContain("10% warning threshold");
      expect(check.fix).toContain("Free inodes");
    }
  },
);

test("filesystems without an inode count are reported as unsupported", () => {
  expect(stateInodeCheck(() => ({ files: 0, ffree: 0 }))).toMatchObject({
    id: "gc:state-inodes",
    status: "skip",
  });
});

test.each([
  [false, "report-only"],
  [true, "no scratch collection plan"],
] as const)(
  "scheduled collection mode %s fails over the limit when it has %s",
  (collect, reason) => {
    const home = mkdtempSync(join(tmpdir(), "fixture-health-"));
    const state = join(home, ".local", "state", "jig");
    const store = join(state, "test-fixtures-v1");
    for (const name of ["first", "second"])
      mkdirSync(join(store, name), { recursive: true });
    const today = Temporal.Now.zonedDateTimeISO("UTC").dayOfWeek % 7;
    const collectDay = collect ? today : (today + 1) % 7;
    const config = join(home, ".jig");
    mkdirSync(config);
    writeFileSync(join(config, "jig.yaml"), `gc: {collect_day: ${collectDay}}`);
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
        resolve(import.meta.dir, "../../jig.ts"),
        "gc",
        "--scheduled",
        "--json",
      ],
      {
        cwd: home,
        timeout: 15000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          JIG_HOME: config,
          JIG_USER_LAYER: undefined,
          JIG_GC_HEAVY_LOCK: undefined,
          JIG_TEST_FIXTURE_REGISTRY_LIMIT: "1",
          RESOURCE_LOCK_BYPASS: "1",
          TZ: "UTC",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(result, 1);
    const path = receiptPaths(join(state, "gc"))[0];
    if (path === undefined)
      throw new Error("The scheduled run did not write a receipt");
    const receipt = readReceipt(path);
    expect(receipt).toMatchObject({
      ok: true,
      value: {
        collect,
        exitStatus: 1,
        failure: {
          code: "fixture-registry-over-limit",
          reason: expect.stringContaining(reason),
        },
      },
    });
  },
);

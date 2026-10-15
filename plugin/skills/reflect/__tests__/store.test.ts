/**
 * The filesystem store against the conformance suite, and the store client's
 * deadlines and exit codes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsArgv } from "../../resolve-review-comments/scripts/lib/proc.ts";
import { EXIT, runStore, Store } from "../scripts/lib/store-client.ts";
import { runConformance, sampleFinding } from "../scripts/store-contract.ts";

const FILESYSTEM_STORE = join(
  import.meta.dir,
  "..",
  "scripts",
  "filesystem-store.ts",
);

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "reflect-store-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function filesystem(path = join(dir, "store")): string[] {
  return tsArgv(FILESYSTEM_STORE, ["--path", path]);
}

describe("the filesystem store", () => {
  it("passes the conformance suite", async () => {
    const results = await runConformance(filesystem());
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  });

  it("fails list naming the file and line of a line that is not an event", async () => {
    const store = join(dir, "store");
    mkdirSync(join(store, "2026-10"), { recursive: true });
    writeFileSync(join(store, "2026-10", "broken.jsonl"), '{"v":1}\n');
    const r = await runStore(filesystem(store), "list", "", 30);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain(join("2026-10", "broken.jsonl"));
    expect(r.stderr).toContain(":1 is not a reflection event");
  });

  it("fails list and diagnose on a symbolic link rather than skip what it holds", async () => {
    const store = join(dir, "store");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(store, { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(
      join(elsewhere, "events.jsonl"),
      `${JSON.stringify(sampleFinding("20261012T150405Z-0000000000000001", "linked"))}\n`,
    );
    symlinkSync(elsewhere, join(store, "2026-10"));
    for (const op of ["list", "diagnose"] as const) {
      const r = await runStore(filesystem(store), op, "", 30);
      expect(r.code).toBe(EXIT.failed);
      expect(r.stderr).toContain("2026-10 is a symbolic link");
    }
  });

  it("skips a half-written temporary file", async () => {
    const store = join(dir, "store");
    mkdirSync(join(store, "2026-10"), { recursive: true });
    writeFileSync(join(store, "2026-10", ".tmp-x.jsonl"), "half a li");
    const r = await runStore(filesystem(store), "list", "", 30);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("checks a folder it cannot create as not writable", async () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "");
    const r = await runStore(filesystem(join(file, "store")), "check", "", 30);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
  });
});

describe("the store client", () => {
  it("reads a store that passes its deadline as unavailable", async () => {
    const slow = join(dir, "slow.ts");
    writeFileSync(slow, "await Bun.sleep(30_000);\n");
    const started = Date.now();
    const r = await runStore(tsArgv(slow), "check", "", 1);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.stderr).toContain("did not finish within 1s");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("gives list and diagnose five times the deadline", async () => {
    const slow = join(dir, "slow.ts");
    writeFileSync(slow, "await Bun.sleep(1500);\nconsole.log('');\n");
    expect((await runStore(tsArgv(slow), "list", "", 1)).code).toBe(0);
    expect((await runStore(tsArgv(slow), "append", "", 1)).code).toBe(
      EXIT.unavailable,
    );
  });

  it("reads a command that cannot start as unavailable", async () => {
    const r = await runStore([join(dir, "no-such-command")], "check", "", 5);
    expect(r.code).toBe(EXIT.unavailable);
  });

  it("refuses an append the store did not report whole", async () => {
    const liar = join(dir, "liar.ts");
    writeFileSync(liar, "console.log(JSON.stringify({ stored: [] }));\n");
    const store = new Store(tsArgv(liar), 30);
    await expect(
      store.append([sampleFinding("20261012T150405Z-0000000000000001", "x")]),
    ).rejects.toThrow("did not report");
  });
});

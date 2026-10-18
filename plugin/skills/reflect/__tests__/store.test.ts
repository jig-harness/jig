/**
 * The filesystem store against the conformance suite, and the store client's
 * deadlines and exit codes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BUFFER_BYTES, tsArgv } from "../../../shared/proc.ts";
import { eventText, KINDS } from "../scripts/lib/events.ts";
import { EXIT, runStore, Store } from "../scripts/lib/store-client.ts";
import {
  BULK_EVENTS,
  BULK_LINE_BYTES,
  main,
  MAX_BULK,
  MAX_TIMEOUT_SEC,
  runConformance,
  sampleFinding,
} from "../scripts/store-contract.ts";
import { ExitError } from "../../../shared/cli.ts";

// A conformance run spawns the store for every check, and the bulk ones
// write and list hundreds of events.
const SUITE_MS = 180_000;
const CAPPED_STORE = join(import.meta.dir, "fixtures", "capped-store.ts");
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
  it(
    "passes the conformance suite",
    async () => {
      const results = await runConformance(filesystem());
      expect(results.filter((result) => !result.ok)).toEqual([]);
      expect(results.length).toBeGreaterThan(10);
    },
    SUITE_MS,
  );

  const capped = (cap: number, ...flags: string[]): string[] =>
    tsArgv(CAPPED_STORE, [
      "--path",
      join(dir, "store"),
      "--cap",
      String(cap),
      ...flags,
    ]);
  const failedNames = (results: { name: string; ok: boolean }[]) =>
    results.filter((result) => !result.ok).map((result) => result.name);

  // Capped at every bulk event, the listing drops only the events stored
  // before them, which a `since` the bulk falls in may leave out; capped at
  // one page, it drops most of the bulk too.
  it(
    "fails only the unfiltered exhaustiveness check when list is capped at every bulk event",
    async () => {
      const results = await runConformance(capped(2 * BULK_EVENTS));
      expect(failedNames(results)).toEqual([
        expect.stringContaining("list returns all"),
      ]);
      expect(results.find((result) => !result.ok)?.detail).toContain("missing");
    },
    SUITE_MS,
  );

  it(
    "fails both exhaustiveness checks when list is capped at one page",
    async () => {
      expect(failedNames(await runConformance(capped(100)))).toEqual([
        expect.stringContaining("list returns all"),
        expect.stringContaining("list with since returns all"),
      ]);
    },
    SUITE_MS,
  );

  it(
    "fails only the since exhaustiveness check when list is capped only with since",
    async () => {
      const results = await runConformance(capped(100, "--since-only"));
      expect(failedNames(results)).toEqual([
        expect.stringContaining("list with since returns all"),
      ]);
      expect(results.find((result) => !result.ok)?.detail).toContain("missing");
    },
    SUITE_MS,
  );

  // A cap above the bulk passes; a larger bulk finds it.
  it(
    "finds a cap above the default bulk only with a larger bulk",
    async () => {
      const cap = 3 * BULK_EVENTS;
      expect(failedNames(await runConformance(capped(cap)))).toEqual([]);
      rmSync(join(dir, "store"), { recursive: true, force: true });
      expect(
        failedNames(await runConformance(capped(cap), 60, undefined, cap)),
      ).toEqual([
        expect.stringContaining("list returns all"),
        expect.stringContaining("list with since returns all"),
      ]);
    },
    SUITE_MS,
  );

  // A listing larger than a store call may capture is stopped, so the largest
  // bulk would fail against a store that lists every event.
  it("keeps the largest bulk's listing within the output a store call may capture", () => {
    const longestKind = KINDS.reduce((a, b) => (b.length > a.length ? b : a));
    const widest = {
      ...sampleFinding(
        `20261012T150405Z-${"f".repeat(16)}`,
        `bulk, one change, ${2 * MAX_BULK}`,
        "2026-10-17T09:00:00Z",
      ),
      kind: longestKind,
      change: {
        repository: "example.invalid/store-contract",
        branch: `contract-${"9".repeat(12)}`,
        pull_request: null,
        issue: null,
      },
    };
    expect(Buffer.byteLength(`${eventText(widest)}\n`)).toBeLessThanOrEqual(
      BULK_LINE_BYTES,
    );
    expect(2 * MAX_BULK * BULK_LINE_BYTES).toBeLessThanOrEqual(
      MAX_BUFFER_BYTES / 2,
    );
  });

  // A bulk the run cannot build would fail only after the earlier checks had
  // written their events, leaving a store the corrected run cannot use.
  it.each([
    ["--bulk", String(MAX_BULK + 1)],
    ["--bulk", "4294967296"],
    ["--bulk", "9".repeat(400)],
    ["--timeout", String(MAX_TIMEOUT_SEC + 1)],
  ])("refuses %s %s before touching the store", async (flag, value) => {
    const store = join(dir, "store");
    const command = ["bun", FILESYSTEM_STORE, "--path", store].join(" ");
    const run = main(["--command", command, flag, value]);
    await expect(run).rejects.toBeInstanceOf(ExitError);
    await expect(run).rejects.toMatchObject({ code: 2 });
    expect(existsSync(store)).toBe(false);
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

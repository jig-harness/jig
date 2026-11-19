/**
 * A head's check-runs listing: each page keeps `GH_CALL_TIMEOUT`, so a long
 * healthy listing is read whole, and a listing that still cannot be read ends
 * the drive as `CHECK_RUNS_UNREADABLE`, naming the pages it read, not exit 1.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { PAGE_CAP } from "../../../shared/outbound/gh-paginate.ts";
import { finalReadListingStop } from "../scripts/lib/driver/convergence-ci.ts";
import { driverRuntime } from "../scripts/lib/driver/runtime.ts";
import { CHECK_RUNS_UNREADABLE_EXIT } from "../scripts/lib/driver/settings.ts";
import * as proc from "../scripts/lib/proc.ts";
import { isDriveEvent } from "../scripts/lib/state/events.ts";
import { checkRunListing } from "../scripts/lib/status/evidence.ts";
import {
  binDir,
  HEAD,
  probe,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDrive } from "./drive-loop-harness.ts";

const SHA = "a".repeat(40);
const LIB = join(import.meta.dir, "../scripts/lib");
const API = `https://api.github.com/repos/o/r/commits/${SHA}/check-runs`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * The listing read in a process of its own, through the real forge client
 * paging it, against a `gh` that answers `pages` pages, each after `delayMs`
 * and page `hangAt` not at all.
 */
async function readListing(f: {
  pages: number;
  delayMs: number;
  hangAt?: number;
  observed?: boolean;
  timeoutSec?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "check-run-listing-"));
  dirs.push(dir);
  // An observed read shares its reading under the repository's scope.
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "https://github.com/o/r.git"],
  ])
    expect(Bun.spawnSync(["git", ...args], { cwd: dir }).exitCode).toBe(0);
  writeFakeProgram(
    join(dir, "gh"),
    `#!/usr/bin/env bun
    const route = process.argv.slice(2).find((a) => a.includes("check-runs"));
    if (route === undefined) {
      console.log(JSON.stringify({ login: "someone", id: 1 }));
      process.exit(0);
    }
    const page = Number(new URL(route, "https://api.github.com/").searchParams.get("page") ?? "1");
    if (page === ${f.hangAt ?? -1}) await Bun.sleep(30_000);
    await Bun.sleep(${f.delayMs});
    const next = page < ${f.pages} ? 'Link: <${API}?per_page=100&page=' + (page + 1) + '>; rel="next"\\n' : "";
    const runs = [{ id: page, name: "check-" + page, status: "completed", conclusion: "success" }];
    process.stdout.write("HTTP/2.0 200 OK\\n" + next + "\\n" + JSON.stringify({ total_count: ${f.pages}, check_runs: runs }));
    `,
  );
  const source = join(dir, "read.ts");
  writeFileSync(
    source,
    `import { checkRunListing } from ${JSON.stringify(join(LIB, "status/evidence.ts"))};
    import { withObservedEvaluation } from ${JSON.stringify(join(LIB, "gh-conditional.ts"))};
    const read = ${f.observed === true ? `await withObservedEvaluation(() => checkRunListing("o", "r", ${JSON.stringify(SHA)}, "observed"))` : `await checkRunListing("o", "r", ${JSON.stringify(SHA)})`};
    console.log(JSON.stringify({ runs: read.runs?.length ?? null, cutShort: read.cutShort }));`,
  );
  const child = Bun.spawn([process.execPath, source], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      XDG_STATE_HOME: join(dir, "state"),
      GH_TOKEN: "test-listing-token",
      GH_CALL_TIMEOUT: f.timeoutSec ?? "2",
      JIG_FORGE_BUDGET: "on",
      PATH: `${dir}${delimiter}${process.env.PATH}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expectSpawnExit({ stdout, stderr, exitCode }, 0);
  return JSON.parse(stdout) as {
    runs: number | null;
    cutShort: { pagesRead: number | null; reason: string } | null;
  };
}

describe("a head's check-runs listing", () => {
  it("is read whole when its pages together outlast one call's deadline", async () => {
    // 15 pages of 200ms each: 3 seconds against a 2-second GH_CALL_TIMEOUT.
    const read = await readListing({ pages: 15, delayMs: 200 });
    expect(read).toEqual({ runs: 15, cutShort: null });
  }, 60_000);

  it("names the pages it read when a page times out", async () => {
    const read = await readListing({ pages: 15, delayMs: 0, hangAt: 3 });
    expect(read.runs).toBeNull();
    expect(read.cutShort?.pagesRead).toBe(2);
    expect(read.cutShort?.reason).toContain("after 2 page(s)");
    expect(read.cutShort?.reason).toContain("each page may take 2s");
  }, 60_000);

  it("names the pages an observed read got through when the listing's bound ends it", async () => {
    // 30 pages of 400ms each against a 4-second bound for the whole listing.
    const read = await readListing({
      pages: 30,
      delayMs: 400,
      observed: true,
      timeoutSec: "1",
    });
    expect(read.runs).toBeNull();
    expect(read.cutShort?.pagesRead).toBeGreaterThan(0);
    expect(read.cutShort?.reason).toContain(
      `after ${read.cutShort?.pagesRead} page(s)`,
    );
  }, 60_000);

  describe("read through the forge client's answer", () => {
    const answering = (result: Partial<proc.RunResult>) => {
      const spy = spyOn(proc, "ghCall");
      spy.mockImplementation(async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        stderrTail: "",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false,
        ...result,
      }));
      return spy;
    };

    it("bounds the whole listing, not one page, on a fresh read", async () => {
      const spy = answering({ code: 0, stdout: "[]" });
      try {
        await checkRunListing("o", "r", SHA);
        expect(spy.mock.calls[0]?.[1]?.pagedWholeSec).toBe(
          proc.checkRunListingSeconds(),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("reports the page bound as the listing cut short", async () => {
      const spy = answering({
        pagesRead: PAGE_CAP,
        held: { code: "too-costly", reason: "too many pages" },
      });
      try {
        const read = await checkRunListing("o", "r", SHA);
        expect(read.runs).toBeNull();
        expect(read.cutShort?.pagesRead).toBe(PAGE_CAP);
        expect(read.cutShort?.reason).toContain("its page bound");
        expect(read.cutShort?.atBound).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("says why when a page was refused short of the bound", async () => {
      const spy = answering({
        pagesRead: 3,
        held: {
          code: "too-costly",
          reason: "the deadline passed while waiting",
        },
      });
      try {
        const read = await checkRunListing("o", "r", SHA);
        expect(read.cutShort?.atBound).toBe(false);
        expect(read.cutShort?.reason).toContain(
          "because the deadline passed while waiting",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("leaves a refusal more time would not mend to the caller", async () => {
      const spy = answering({ stderr: "gh: Not Found (HTTP 404)\n" });
      try {
        expect(await checkRunListing("o", "r", SHA)).toEqual({
          runs: null,
          cutShort: null,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("stops on a final status re-read that found the listing cut short, and on no other answer", () => {
    try {
      expect(
        finalReadListingStop(CHECK_RUNS_UNREADABLE_EXIT, {
          reason: "cut short",
          listingPagesRead: 14,
        }),
      ).toBe(CHECK_RUNS_UNREADABLE_EXIT);
      expect(driverRuntime.stopListingPages).toBe(14);
      expect(
        finalReadListingStop(4, { state: "AWAITING_REVIEWER" }),
      ).toBeNull();
    } finally {
      driverRuntime.stopListingPages = null;
    }
  });

  it("keeps the pages read on a stop event, and on no other kind", () => {
    const event = { at: "2026-11-18T00:00:00.000Z", round: 1, cause: "24" };
    expect(isDriveEvent({ ...event, kind: "stop", listingPages: 14 })).toBe(
      true,
    );
    expect(isDriveEvent({ ...event, kind: "stop", listingPages: -1 })).toBe(
      false,
    );
    expect(
      isDriveEvent({
        ...event,
        kind: "restart",
        cause: "stall",
        listingPages: 14,
      }),
    ).toBe(false);
  });
});

describe("a listing cut short ends the round and the drive by name", () => {
  useDrivePrSuite();
  const env = { GH_CALL_TIMEOUT: "1" };

  it("drive-status.ts reports CHECK_RUNS_UNREADABLE, not INDETERMINATE", async () => {
    const r = await probe({ threads: [], checkRunsHang: true }, [], { env });
    expect(r.state).toBe("CHECK_RUNS_UNREADABLE");
    expect(r.exitCode).toBe(CHECK_RUNS_UNREADABLE_EXIT);
    expect(String(r.json.reason)).toContain(HEAD);
    expect(String(r.json.reason)).toContain("an unknown number of pages");
    expect(r.json).toHaveProperty("listingPagesRead", null);
  }, 60_000);

  it("ci-hold.ts final-ready answers with it and the pages read", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      checkRunsHang: true,
    });
    const child = Bun.spawn(
      [
        process.execPath,
        join(LIB, "../ci-hold.ts"),
        "final-ready",
        "999",
        "--expect-head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          ...env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, CHECK_RUNS_UNREADABLE_EXIT);
    expect(JSON.parse(stdout)).toEqual({ listingPagesRead: null });
    expect(stderr).toContain("check-runs listing");
  }, 60_000);

  it("drive.ts exits with it instead of 1", async () => {
    const r = await runDrive(
      { threads: [], checkRunsHang: true },
      [
        "--keep-draft",
        "--no-head-sync",
        "--interval",
        "5",
        "--",
        "sh",
        "-c",
        ": pass for 999",
      ],
      undefined,
      { env },
    );
    expectSpawnExit({ ...r, stdout: null }, CHECK_RUNS_UNREADABLE_EXIT);
    expect(r.stderr).toContain("check-runs listing");
  }, 120_000);
});

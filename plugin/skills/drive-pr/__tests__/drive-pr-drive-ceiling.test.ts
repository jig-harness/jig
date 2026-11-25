/**
 * drive-pr suite: the economic circuit breaker end to end. A drive whose
 * pull request has spent its round ceiling or its wall-clock cap parks
 * `round-ceiling`; a re-arm grants nothing past the ceiling, and only
 * `--past-ceiling` raises it; rounds that keep raising as many findings as
 * they fix park `divergence-stop`, and rounds that converge never do.
 */
import { describe, expect, it } from "bun:test";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "../../../shared/yaml.ts";
import { isoFromMs, currentMs } from "../../../shared/time.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  PREV,
  scratchClean,
  writeFixture as rawFixture,
  useDrivePrSuite,
  type FixtureThread,
} from "./drive-pr-harness.ts";
import {
  PASS_LOUD,
  skipLongDriveFixture,
  spawnDriveIn,
} from "./drive-loop-harness.ts";
import { readState, seedRounds, writeState } from "./state-rows.ts";

const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

const MULTI_ROUND_TIMEOUT_MS = 90_000;

useDrivePrSuite();

const bot = (id: string): FixtureThread => ({ id, path: "a.ts", bot: true });

/** The suite's overlay with these `drive` fields, `undefined` removing one. */
function overlay(dir: string, fields: Record<string, unknown>): string {
  const path = join(dir, "ceiling-overlay.json");
  const suite = loadYaml(
    readFileSync(process.env.JIG_OVERLAY as string, "utf8"),
  ) as Record<string, unknown>;
  const drive = { ...((suite.drive ?? {}) as Record<string, unknown>) };
  for (const [key, value] of Object.entries(fields))
    if (value === undefined) delete drive[key];
    else drive[key] = value;
  // A park routes its question to a person; the fixture forge reads no author.
  const dispatch = { person: "drive-user" };
  writeFileSync(path, JSON.stringify({ ...suite, drive, dispatch }));
  return path;
}

/** One drive of `f` with `args` before the pass command, under `fields`. */
async function drive(
  f: { dir: string; stateDir: string },
  fields: Record<string, unknown>,
  args: string[],
  pass: string[] = PASS_LOUD,
) {
  const p = spawnDriveIn(
    f.dir,
    f.stateDir,
    ["--no-head-sync", ...args, "--", ...pass],
    undefined,
    {
      env: {
        JIG_OVERLAY: overlay(f.dir, fields),
        // The stall stop would end the no-op passes first: the budget and
        // the circuit breaker are the subject.
        DRIVE_PR_STALL_ROUNDS: "0",
        DRIVE_PR_LEDGER: "off",
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const passes = stderr.match(/RAN_THE_PASS/g)?.length ?? 0;
  return { stdout, stderr, exitCode, passes };
}

type Parked = { key: string; decision?: { steps: string[] }; at?: string };

function parked(stateDir: string): Parked[] {
  return (readState(stateDir, "999")?.parked ?? []) as Parked[];
}

function park(stateDir: string, key: string): Parked | undefined {
  return parked(stateDir).find((p) => p.key === key);
}

describe("the round ceiling", () => {
  it(
    "parks round-ceiling once the counted heads pass it, stating the rounds and the refusal",
    async () => {
      const f = writeFixture({ threads: [bot("PRRT_a")] });
      // Two heads counted; the head about to be reviewed is the third.
      seedRounds(f.stateDir, 2, PREV);
      const r = await drive(f, { max_total_rounds: 2 }, ["--max-rounds", "10"]);
      expectSpawnExit({ ...r, stdout: null }, 8);
      expect(r.passes).toBe(0);
      expect(r.stderr).toContain("round ceiling reached on PR #999");
      const steps = park(f.stateDir, "round-ceiling")?.decision?.steps ?? [];
      expect(steps.join("\n")).toContain("2 distinct reviewed head(s)");
      expect(steps.join("\n")).toContain("round ceiling of 2");
      expect(steps.join("\n")).toContain("Automatic re-arming is refused");
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it(
    "is 8 when drive.max_total_rounds is not set",
    async () => {
      const f = writeFixture({ threads: [bot("PRRT_a")] });
      seedRounds(f.stateDir, 8, PREV);
      const r = await drive(f, { max_total_rounds: undefined }, []);
      expectSpawnExit({ ...r, stdout: null }, 8);
      expect(r.passes).toBe(0);
      expect(
        park(f.stateDir, "round-ceiling")?.decision?.steps.join("\n"),
      ).toContain("round ceiling of 8 (the default)");
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it(
    "refuses a value past its bound, naming the setting",
    async () => {
      const f = writeFixture({ threads: [bot("PRRT_a")] });
      const r = await drive(f, { max_total_rounds: 51 }, []);
      expectSpawnExit({ ...r, stdout: null }, 1);
      expect(r.stderr).toContain(
        "drive.max_total_rounds must be a whole number",
      );
      expect(r.passes).toBe(0);
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it.skipIf(skipLongDriveFixture)(
    "grants a re-arm nothing past it, and drives one more budget only on --past-ceiling",
    async () => {
      const f = writeFixture({ threads: [bot("PRRT_a")] });
      seedRounds(f.stateDir, 2, PREV);
      const ceiling = { max_total_rounds: 2 };
      const stopped = await drive(f, ceiling, ["--max-rounds", "1"]);
      expectSpawnExit({ ...stopped, stdout: null }, 8);
      const parkedAt = park(f.stateDir, "round-ceiling")?.at;
      expect(parkedAt).toBeDefined();

      // The re-arm a dispatcher would launch on a person's rearm label.
      const rearmed = await drive(f, ceiling, [
        "--max-rounds",
        "1",
        "--rearm-budget",
      ]);
      expectSpawnExit({ ...rearmed, stdout: null }, 8);
      expect(rearmed.passes).toBe(0);
      expect(rearmed.stderr).toContain("a re-arm grants nothing past it");
      // The park a person may already be answering is kept as it was.
      expect(park(f.stateDir, "round-ceiling")?.at).toBe(parkedAt);
      expect(readState(f.stateDir, "999")?.roundsGranted ?? 0).toBe(0);

      const overridden = await drive(f, ceiling, [
        "--max-rounds",
        "1",
        "--past-ceiling",
      ]);
      expectSpawnExit({ ...overridden, stdout: null }, 6);
      expect(overridden.stderr).toContain("round ceiling to 3");
      expect(overridden.passes).toBe(1);
      const state = readState(f.stateDir, "999");
      expect(state?.ceilingRaised).toBe(1);
      expect(park(f.stateDir, "round-ceiling")).toBeUndefined();
    },
    MULTI_ROUND_TIMEOUT_MS,
  );
});

describe("the wall-clock cap", () => {
  it(
    "parks round-ceiling once the hours since the first launch reach it",
    async () => {
      const f = writeFixture({ threads: [bot("PRRT_a")] });
      seedRounds(f.stateDir, 1, PREV);
      const seeded = readState(f.stateDir, "999") ?? {};
      writeState(f.stateDir, "999", {
        ...seeded,
        firstDrivenAt: isoFromMs(currentMs() - 2 * 3_600_000),
      });
      const r = await drive(f, { max_wall_clock_hours: 1 }, []);
      expectSpawnExit({ ...r, stdout: null }, 8);
      expect(r.passes).toBe(0);
      expect(r.stderr).toContain("wall-clock cap reached on PR #999");
      expect(
        park(f.stateDir, "round-ceiling")?.decision?.steps.join("\n"),
      ).toContain("wall-clock cap is 1h");
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it(
    "records the first launch once and never moves it",
    async () => {
      const f = writeFixture({ threads: [bot("PRRT_a")] });
      const first = await drive(f, {}, ["--max-rounds", "1"]);
      expectSpawnExit({ ...first, stdout: null }, 6);
      const at = readState(f.stateDir, "999")?.firstDrivenAt;
      expect(typeof at).toBe("string");
      const again = await drive(f, {}, ["--max-rounds", "1", "--rearm-budget"]);
      expectSpawnExit({ ...again, stdout: null }, 6);
      expect(readState(f.stateDir, "999")?.firstDrivenAt).toBe(at);
    },
    MULTI_ROUND_TIMEOUT_MS,
  );
});

describe("the divergence stop", () => {
  /**
   * A drive whose open threads are `sets[0]` before the first pass, and
   * whose n-th pass replaces them with `sets[n]`, as a reviewer raising new
   * findings on each round's fixes would.
   */
  async function driveThrough(sets: string[][], maxRounds: string) {
    const [first, ...later] = sets;
    const f = writeFixture({ threads: (first ?? []).map(bot) });
    later.forEach((ids, i) => {
      const next = writeFixture({ threads: ids.map(bot) });
      copyFileSync(
        join(next.dir, "threads.json"),
        join(f.dir, `threads-${i + 1}.json`),
      );
    });
    const pass = [
      "sh",
      "-c",
      'n=$(cat "$DRIVE_PR_FIXTURES/n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$DRIVE_PR_FIXTURES/n"; ' +
        '[ -f "$DRIVE_PR_FIXTURES/threads-$n.json" ] && cp "$DRIVE_PR_FIXTURES/threads-$n.json" "$DRIVE_PR_FIXTURES/threads.json"; ' +
        'echo "pass for 999: RAN_TH""E_PASS" >&2; exit 0',
    ];
    const r = await drive(f, {}, ["--max-rounds", maxRounds], pass);
    return { f, r };
  }

  it.skipIf(skipLongDriveFixture)(
    "parks divergence-stop after two rounds that each raised at least as many findings as they fixed",
    async () => {
      const { f, r } = await driveThrough(
        [["PRRT_a1"], ["PRRT_b1", "PRRT_b2"], ["PRRT_c1", "PRRT_c2"]],
        "10",
      );
      expectSpawnExit({ ...r, stdout: null }, 8);
      expect(r.passes).toBe(2);
      expect(r.stderr).toContain("divergence stop on PR #999");
      const steps = park(f.stateDir, "divergence-stop")?.decision?.steps ?? [];
      expect(steps.join("\n")).toContain("2 new finding(s), 1 fixed, 2 open");
      expect(steps.join("\n")).toContain("2 new finding(s), 2 fixed, 2 open");
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it.skipIf(skipLongDriveFixture)(
    "does not park while findings strictly decrease",
    async () => {
      const { f, r } = await driveThrough(
        [
          ["PRRT_a1", "PRRT_a2", "PRRT_a3"],
          ["PRRT_a1", "PRRT_a2"],
          ["PRRT_a1"],
        ],
        "3",
      );
      expectSpawnExit({ ...r, stdout: null }, 6);
      expect(r.passes).toBe(3);
      expect(park(f.stateDir, "divergence-stop")).toBeUndefined();
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it.skipIf(skipLongDriveFixture)(
    "does not park when a diverging round is followed by a converging one",
    async () => {
      const { f, r } = await driveThrough(
        [
          ["PRRT_a1", "PRRT_a2"],
          ["PRRT_b1", "PRRT_b2"],
          ["PRRT_b1"],
          ["PRRT_c1", "PRRT_c2"],
        ],
        "3",
      );
      expectSpawnExit({ ...r, stdout: null }, 6);
      expect(r.passes).toBe(3);
      expect(park(f.stateDir, "divergence-stop")).toBeUndefined();
      const history = readState(f.stateDir, "999")?.roundFindings as unknown[];
      expect(history).toHaveLength(3);
    },
    MULTI_ROUND_TIMEOUT_MS,
  );
});

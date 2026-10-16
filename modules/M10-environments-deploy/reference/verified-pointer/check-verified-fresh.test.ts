import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  checkShape,
  decideByCause,
  decideByThreshold,
  modeOf,
  type Observation,
  parseObservation,
  readMaxHealAttempts,
  readSettings,
} from "./check-verified-fresh.ts";

const gate = join(import.meta.dir, "check-verified-fresh.ts"),
  fix = join(import.meta.dir, "fixtures");
const fixture = (name: string) => join(fix, name);

const OBSERVATION_KEYS = [
  "ANCESTOR",
  "CODE_AHEAD",
  "UNVERIFIED_AGE_SECONDS",
  "VERIFICATION",
  "QUEUE_WAIT_SECONDS",
  "HEAL_ATTEMPTS",
  "BEHIND",
  "AGE_SECONDS",
  "MAX_QUEUE_WAIT_SECONDS",
  "GRACE_SECONDS",
  "MAX_BEHIND",
  "MAX_AGE_SECONDS",
  "GITHUB_ACTIONS",
];

/** The environment with no observation or setting the caller did not give. */
function cleanEnv(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !OBSERVATION_KEYS.includes(key))
      clean[key] = value;
  return { ...clean, ...env };
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    env: cleanEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    result,
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

const cases: [string, number][] = [
  ["fresh.txt", 0],
  ["boundary.txt", 0],
  ["lagging-behind.txt", 1],
  ["lagging-age.txt", 1],
  ["bad-value.txt", 2],
  ["unknown-key.txt", 2],
  ["duplicate-key.txt", 2],
  ["huge-value.txt", 2],
  ["empty.txt", 2],
  ["cause-no-code-ahead.txt", 0],
  ["cause-verifying.txt", 0],
  ["cause-blocked.txt", 0],
  ["cause-within-grace.txt", 0],
  ["cause-grace-boundary.txt", 0],
  ["cause-dropped-trigger.txt", 1],
  ["cause-aborted-run.txt", 1],
  ["cause-heal-below-budget.txt", 1],
  ["cause-heal-exhausted.txt", 1],
  ["cause-ran-but-stale.txt", 1],
  ["cause-diverged.txt", 1],
  ["cause-queue-stalled.txt", 1],
  ["cause-stalled-and-diverged.txt", 1],
  ["cause-bad-state.txt", 2],
  ["cause-bad-yes-no.txt", 2],
  ["cause-bad-heal-attempts.txt", 2],
  ["cause-missing-queue.txt", 2],
  ["cause-missing-verification.txt", 2],
  ["cause-mixed-modes.txt", 2],
];
for (const [file, code] of cases)
  test(file, () => expectSpawnExit(run([fixture(file)]).result, code, file));

test("a missing input file fails closed", () =>
  expectSpawnExit(run([fixture("does-not-exist.txt")]).result, 2));

test("each cause writes its verdicts to the output file", () => {
  const dir = mkdtempSync(join(tmpdir(), "verified-pointer-"));
  const expected: Record<string, string> = {
    "cause-no-code-ahead.txt": "queue=ok\npointer=no-code-ahead\n",
    "cause-verifying.txt": "queue=ok\npointer=verifying\n",
    "cause-blocked.txt": "queue=ok\npointer=blocked\n",
    "cause-within-grace.txt": "queue=ok\npointer=within-grace\n",
    "cause-dropped-trigger.txt": "queue=ok\npointer=dropped-trigger\n",
    "cause-aborted-run.txt": "queue=ok\npointer=dropped-trigger\n",
    "cause-heal-below-budget.txt": "queue=ok\npointer=dropped-trigger\n",
    "cause-heal-exhausted.txt": "queue=ok\npointer=heal-exhausted\n",
    "cause-ran-but-stale.txt": "queue=ok\npointer=ran-but-stale\n",
    "cause-diverged.txt": "queue=ok\npointer=diverged\n",
    "cause-queue-stalled.txt": "queue=stalled\npointer=verifying\n",
    "cause-stalled-and-diverged.txt": "queue=stalled\npointer=diverged\n",
    "fresh.txt": "pointer=fresh\n",
    "lagging-age.txt": "pointer=lagging\n",
  };
  for (const [file, content] of Object.entries(expected)) {
    const output = join(dir, `${file}.out`);
    run(["--output", output, fixture(file)]);
    expect(readFileSync(output, "utf8"), file).toBe(content);
  }
});

test("the output file is appended to, as a job's output file is", () => {
  const output = join(mkdtempSync(join(tmpdir(), "verified-pointer-")), "out");
  run(["--output", output, fixture("cause-verifying.txt")]);
  run(["--output", output, fixture("fresh.txt")]);
  expect(readFileSync(output, "utf8")).toBe(
    "queue=ok\npointer=verifying\npointer=fresh\n",
  );
});

test("nothing is written to the output file when the input is unusable", () => {
  const output = join(mkdtempSync(join(tmpdir(), "verified-pointer-")), "out");
  expectSpawnExit(
    run(["--output", output, fixture("cause-bad-state.txt")]).result,
    2,
  );
  expect(() => readFileSync(output)).toThrow();
});

test("a failing cause names its remedy", () => {
  const remedies: [string, string][] = [
    ["cause-dropped-trigger.txt", "heal it: dispatch verification at the tip"],
    ["cause-aborted-run.txt", "heal it: dispatch verification at the tip"],
    ["cause-heal-below-budget.txt", "(heal 3 of 3)"],
    ["cause-heal-exhausted.txt", "do not dispatch again"],
    ["cause-ran-but-stale.txt", "a person looks at the advance step"],
    ["cause-diverged.txt", "back-merge"],
    ["cause-queue-stalled.txt", "cancel the run that holds the slot"],
  ];
  for (const [file, remedy] of remedies) {
    const { out, err } = run([fixture(file)]);
    expect(err, file).toContain("\n  fix: ");
    expect(err, file).toContain(remedy);
    expect(out, file).toStartWith("queue:");
    expect(out, file).toContain("\nFAIL — ");
  }
});

test("both findings are reported when the queue stalls and the pointer diverged", () => {
  const { out, err } = run([fixture("cause-stalled-and-diverged.txt")]);
  expect(err).toContain("[queue-stalled]");
  expect(err).toContain("[diverged]");
  expect(out).toContain("FAIL — queue-stalled, diverged");
});

test("a pass says so and explains each verdict", () => {
  const { out, err } = run([fixture("cause-blocked.txt")]);
  expect(out).toBe(
    "queue: ok, longest runner wait 0s (max 2700s)\npointer: blocked, verification failed for the tip, so the gates held the pointer back\nOK — nothing to do\n",
  );
  expect(err).toBe("");
});

test("under GitHub Actions a finding is also an annotation", () => {
  const { out } = run([fixture("cause-dropped-trigger.txt")], {
    GITHUB_ACTIONS: "true",
  });
  expect(out).toContain("::error title=dropped-trigger::");
});

test("an unusable input is reported as could-not-check, not a finding", () => {
  const { err } = run([fixture("cause-bad-state.txt")]);
  expect(err).toContain("verified-pointer: could not check: VERIFICATION");
  expect(err).not.toContain("fix:");
});

const dropped = {
  ANCESTOR: "yes",
  CODE_AHEAD: "yes",
  UNVERIFIED_AGE_SECONDS: "2400",
  VERIFICATION: "none",
  QUEUE_WAIT_SECONDS: "0",
};

test("the observation can come from the environment alone", () => {
  expectSpawnExit(run([], dropped).result, 1);
  expectSpawnExit(run([], { ...dropped, VERIFICATION: "running" }).result, 0);
  expectSpawnExit(run([], { BEHIND: "3", AGE_SECONDS: "3600" }).result, 0);
  expectSpawnExit(run([], { BEHIND: "5" }).result, 0);
  expectSpawnExit(run([], { BEHIND: "999" }).result, 1);
  expectSpawnExit(run([], { AGE_SECONDS: "999999" }).result, 1);
});

test("an observation key set to the empty string is malformed, not absent", () => {
  const empty = run([], { ...dropped, HEAL_ATTEMPTS: "" });
  expectSpawnExit(empty.result, 2);
  expect(empty.err).toContain("HEAL_ATTEMPTS must be a non-negative integer");
  expectSpawnExit(run([], { ...dropped, VERIFICATION: "" }).result, 2);
});

test("a key in both the environment and the file fails closed", () => {
  const { result, err } = run([fixture("cause-within-grace.txt")], {
    QUEUE_WAIT_SECONDS: "0",
  });
  expectSpawnExit(result, 2);
  expect(err).toContain("QUEUE_WAIT_SECONDS is given both");
});

test("keys of both modes across the environment and the file fail closed", () =>
  expectSpawnExit(run([fixture("fresh.txt")], { ANCESTOR: "yes" }).result, 2));

test("no observation at all fails closed", () =>
  expectSpawnExit(run([]).result, 2));

test("the grace window and the queue bound are settings", () => {
  expectSpawnExit(run([], { ...dropped, GRACE_SECONDS: "2400" }).result, 0);
  expectSpawnExit(run([], { ...dropped, GRACE_SECONDS: "2399" }).result, 1);
  const stalled = {
    ...dropped,
    VERIFICATION: "running",
    QUEUE_WAIT_SECONDS: "100",
  };
  expectSpawnExit(run([], stalled).result, 0);
  expectSpawnExit(
    run([], { ...stalled, MAX_QUEUE_WAIT_SECONDS: "99" }).result,
    1,
  );
  expectSpawnExit(run([], { MAX_BEHIND: "100", BEHIND: "50" }).result, 0);
  expectSpawnExit(run([], { MAX_BEHIND: "2", BEHIND: "3" }).result, 1);
});

const badSettings: Record<string, string>[] = [
  { MAX_BEHIND: "-1", BEHIND: "1" },
  { MAX_BEHIND: "lots", BEHIND: "1" },
  { MAX_AGE_SECONDS: "-5", AGE_SECONDS: "1" },
  { GRACE_SECONDS: "20m", ...dropped },
  { MAX_QUEUE_WAIT_SECONDS: "0x10", ...dropped },
];
for (const env of badSettings)
  test(`a bad setting ${JSON.stringify(env)} is a usage error`, () =>
    expectSpawnExit(run([], env).result, 2));

test("the heal budget is an option, and the verdict turns at it", () => {
  const healed = { ...dropped, HEAL_ATTEMPTS: "1" };
  expectSpawnExit(run([], healed).result, 1);
  const dir = mkdtempSync(join(tmpdir(), "verified-pointer-"));
  let n = 0;
  const outputs = (args: string[], env: Record<string, string>) => {
    n += 1;
    const output = join(dir, `${n}.out`);
    run(["--output", output, ...args], env);
    return readFileSync(output, "utf8");
  };
  expect(outputs(["--max-heal-attempts", "2"], healed)).toBe(
    "queue=ok\npointer=dropped-trigger\n",
  );
  expect(outputs(["--max-heal-attempts", "1"], healed)).toBe(
    "queue=ok\npointer=heal-exhausted\n",
  );
  expect(
    outputs(
      ["--max-heal-attempts", "4", fixture("cause-heal-exhausted.txt")],
      {},
    ),
  ).toBe("queue=ok\npointer=dropped-trigger\n");
});

for (const args of [
  ["--max-heal-attempts", "0", fixture("cause-dropped-trigger.txt")],
  ["--max-heal-attempts", "-1", fixture("cause-dropped-trigger.txt")],
  ["--max-heal-attempts", "three", fixture("cause-dropped-trigger.txt")],
  ["--max-heal-attempts"],
])
  test(`a bad heal budget ${args.slice(0, 2).join(" ")} is a usage error`, () =>
    expectSpawnExit(run(args).result, 2));

for (const args of [
  ["--output"],
  ["--frobnicate", fixture("fresh.txt")],
  [fixture("fresh.txt"), fixture("boundary.txt")],
])
  test(`fails closed on ${args.map((a) => a.replace(fix, "")).join(" ")}`, () =>
    expectSpawnExit(run(args).result, 2));

const settings = readSettings({});

test("at the bound is within it; strictly over is not", () => {
  const at = {
    ...dropped,
    UNVERIFIED_AGE_SECONDS: "1200",
    QUEUE_WAIT_SECONDS: "2700",
  };
  expect(decideByCause(at, settings).outputs).toEqual([
    ["queue", "ok"],
    ["pointer", "within-grace"],
  ]);
  const over = {
    ...dropped,
    UNVERIFIED_AGE_SECONDS: "1201",
    QUEUE_WAIT_SECONDS: "2701",
  };
  expect(decideByCause(over, settings).outputs).toEqual([
    ["queue", "stalled"],
    ["pointer", "dropped-trigger"],
  ]);
  expect(
    decideByThreshold({ BEHIND: "20", AGE_SECONDS: "86400" }, settings).outputs,
  ).toEqual([["pointer", "fresh"]]);
  expect(decideByThreshold({ BEHIND: "21" }, settings).findings).toHaveLength(
    1,
  );
  expect(
    decideByThreshold({ AGE_SECONDS: "86401" }, settings).findings,
  ).toHaveLength(1);
});

test("every verification state maps to one pointer verdict", () => {
  const verdict = (state: string, age = "2400") =>
    decideByCause(
      { ...dropped, VERIFICATION: state, UNVERIFIED_AGE_SECONDS: age },
      settings,
    );
  expect(verdict("running").outputs[1]).toEqual(["pointer", "verifying"]);
  expect(verdict("failed").outputs[1]).toEqual(["pointer", "blocked"]);
  expect(verdict("succeeded").outputs[1]).toEqual(["pointer", "ran-but-stale"]);
  expect(verdict("none").outputs[1]).toEqual(["pointer", "dropped-trigger"]);
  expect(verdict("aborted").outputs[1]).toEqual(["pointer", "dropped-trigger"]);
  const healed = (attempts: string, state = "aborted") =>
    decideByCause(
      { ...dropped, VERIFICATION: state, HEAL_ATTEMPTS: attempts },
      settings,
    ).outputs[1];
  expect(healed("0")).toEqual(["pointer", "dropped-trigger"]);
  expect(healed("2")).toEqual(["pointer", "dropped-trigger"]);
  expect(healed("3")).toEqual(["pointer", "heal-exhausted"]);
  expect(healed("4", "none")).toEqual(["pointer", "heal-exhausted"]);
  // The budget bounds only the heal: a run that decides still decides.
  expect(healed("9", "failed")).toEqual(["pointer", "blocked"]);
  expect(healed("9", "running")).toEqual(["pointer", "verifying"]);
  expect(verdict("none", "0").outputs[1]).toEqual(["pointer", "within-grace"]);
  expect(verdict("aborted", "1200").outputs[1]).toEqual([
    "pointer",
    "within-grace",
  ]);
  // A success is sticky: nothing about the tip's age changes the verdict.
  expect(verdict("succeeded", "0").outputs[1]).toEqual([
    "pointer",
    "ran-but-stale",
  ]);
});

test("a diverged pointer needs no other pointer key, and reads none", () => {
  expect(
    decideByCause({ ANCESTOR: "no", QUEUE_WAIT_SECONDS: "0" }, settings)
      .outputs,
  ).toEqual([
    ["queue", "ok"],
    ["pointer", "diverged"],
  ]);
  expect(
    decideByCause(
      { ...dropped, ANCESTOR: "no", VERIFICATION: "succeeded" },
      settings,
    ).outputs[1],
  ).toEqual(["pointer", "diverged"]);
});

test("a required key that is missing is an error, never a default", () => {
  const missing: [Observation, string][] = [
    [{ ANCESTOR: "yes", CODE_AHEAD: "no" }, "QUEUE_WAIT_SECONDS is required"],
    [{ QUEUE_WAIT_SECONDS: "0" }, "ANCESTOR is required"],
    [{ ANCESTOR: "yes", QUEUE_WAIT_SECONDS: "0" }, "CODE_AHEAD is required"],
    [
      {
        ANCESTOR: "yes",
        CODE_AHEAD: "yes",
        QUEUE_WAIT_SECONDS: "0",
        UNVERIFIED_AGE_SECONDS: "1",
      },
      "VERIFICATION is required",
    ],
    [
      {
        ANCESTOR: "yes",
        CODE_AHEAD: "yes",
        QUEUE_WAIT_SECONDS: "0",
        VERIFICATION: "none",
      },
      "UNVERIFIED_AGE_SECONDS is required",
    ],
  ];
  for (const [observation, message] of missing)
    expect(() => decideByCause(observation, settings)).toThrow(message);
});

test("the shape of every supplied value is checked, whichever mode", () => {
  expect(() => checkShape({ ANCESTOR: "true" })).toThrow(
    "ANCESTOR must be yes or no",
  );
  expect(() => checkShape({ CODE_AHEAD: "1" })).toThrow(
    "CODE_AHEAD must be yes or no",
  );
  expect(() => checkShape({ VERIFICATION: "queued" })).toThrow(
    "VERIFICATION must be one of",
  );
  expect(() => checkShape({ UNVERIFIED_AGE_SECONDS: "-1" })).toThrow(
    "UNVERIFIED_AGE_SECONDS must be",
  );
  expect(() => checkShape({ QUEUE_WAIT_SECONDS: "45m" })).toThrow(
    "QUEUE_WAIT_SECONDS must be",
  );
  expect(() => checkShape({ HEAL_ATTEMPTS: "-1" })).toThrow(
    "HEAL_ATTEMPTS must be",
  );
  expect(() => checkShape({ BEHIND: "3.5" })).toThrow("BEHIND must be");
  expect(() => checkShape({ AGE_SECONDS: "9999999999999999999" })).toThrow(
    "AGE_SECONDS must be",
  );
  expect(() => checkShape(dropped)).not.toThrow();
});

test("modeOf tells the modes apart and refuses a mix or nothing", () => {
  expect(modeOf(dropped)).toBe("cause");
  expect(modeOf({ BEHIND: "1" })).toBe("threshold");
  expect(() => modeOf({ ...dropped, AGE_SECONDS: "1" })).toThrow("not both");
  expect(() => modeOf({})).toThrow("no observation given");
});

test("parseObservation reads key-value lines and refuses the rest", () => {
  expect(
    parseObservation("# c\n\nBEHIND 3 # trailing\nAGE_SECONDS 4\n", "f"),
  ).toEqual({
    BEHIND: "3",
    AGE_SECONDS: "4",
  });
  expect(() => parseObservation("BEHIND\n", "f")).toThrow(
    "f:1: want '<KEY> <value>'",
  );
  expect(() => parseObservation("BEHIND 3 4\n", "f")).toThrow(
    "f:1: want '<KEY> <value>'",
  );
  expect(() => parseObservation("behind 3\n", "f")).toThrow(
    "f:1: unknown key behind",
  );
  expect(() => parseObservation("BEHIND 3\nBEHIND 3\n", "f")).toThrow(
    "f:2: BEHIND is given twice",
  );
  expect(() => parseObservation("BEHIND 3\n", "f", { BEHIND: "3" })).toThrow(
    "f:1: BEHIND is given both here and in the environment",
  );
  expect(parseObservation("CODE_AHEAD no\n", "f", { ANCESTOR: "yes" })).toEqual(
    {
      ANCESTOR: "yes",
      CODE_AHEAD: "no",
    },
  );
});

test("readSettings validates each setting and keeps the defaults", () => {
  expect(settings).toEqual({
    maxQueueWaitSeconds: 2700n,
    graceSeconds: 1200n,
    maxBehind: 20n,
    maxAgeSeconds: 86400n,
    maxHealAttempts: 3n,
  });
  expect(readSettings({ GRACE_SECONDS: "0" }).graceSeconds).toBe(0n);
  expect(() => readSettings({ GRACE_SECONDS: "1e3" })).toThrow(
    "GRACE_SECONDS must be",
  );
});

test("readMaxHealAttempts takes a positive integer and defaults to 3", () => {
  expect(readMaxHealAttempts(undefined)).toBe(3n);
  expect(readMaxHealAttempts("1")).toBe(1n);
  for (const raw of ["0", "-1", "2.5", "", "1e2"])
    expect(() => readMaxHealAttempts(raw), raw).toThrow(
      "--max-heal-attempts must be a positive integer",
    );
});

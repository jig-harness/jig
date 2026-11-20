import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type FinalCiSignals,
  FinalCiWait,
} from "../scripts/lib/final-ci-wait.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const HEAD = "a".repeat(40);
type Sig = Omit<FinalCiSignals, "observedAt">;
function fixture() {
  let now = 0;
  let readDelay = 0;
  let current: Sig | null = {
    head: HEAD,
    pull: "open-pull",
    unchanged: false,
  };
  let reads = 0;
  const gate = new FinalCiWait("123", 300_000, {
    now: () => now,
    signals: async () => {
      reads += 1;
      const observedAt = now;
      now += readDelay;
      return current === null ? null : { ...current, observedAt };
    },
  });
  return {
    gate,
    set: (next: Sig | null) => {
      current = next;
    },
    time: (next: number) => {
      now = next;
    },
    delay: (next: number) => {
      readDelay = next;
    },
    reads: () => reads,
    arm: async (unwitnessed = true) => {
      current = { head: HEAD, pull: "open-pull", unchanged: false };
      const before = await gate.prime();
      gate.remember(HEAD, before, unwitnessed);
      current = { head: HEAD, pull: "open-pull", unchanged: true };
    },
  };
}

describe("final CI keep-waiting gate", () => {
  it("backs off unchanged signal requests with a sixty-second detection bound", async () => {
    const f = fixture();
    await f.arm();
    for (let now = 0; now < 300_000; now += 10_000) {
      f.time(now);
      expect(await f.gate.skip(1, 180)).toBe("witness");
    }
    // Prime plus probes at 0, 20, 60, 120, 180 and 240 seconds.
    expect(f.reads()).toBe(7);
    f.time(300_000);
    expect(await f.gate.skip(1, 180)).toBeNull();
  });

  it("forces fresh evidence at the elapsed witness deadline despite backoff", async () => {
    const f = fixture();
    await f.arm();
    expect(await f.gate.skip(1, 180, 25_000)).toBe("witness");
    f.time(20_000);
    expect(await f.gate.skip(1, 180, 25_000)).toBe("witness");
    f.time(25_000);
    expect(await f.gate.skip(1, 180, 25_000)).toBeNull();
  });

  it("measures witness expiry by elapsed time, resets on a new head or witness", () => {
    const f = fixture();
    expect(f.gate.witnessSpent(HEAD, 3)).toBe(false);
    for (let poll = 0; poll < 1000; poll++)
      expect(f.gate.witnessSpent(HEAD, 3)).toBe(false);
    f.time(29_999);
    expect(f.gate.witnessSpent(HEAD, 3)).toBe(false);
    f.time(30_000);
    expect(f.gate.witnessSpent(HEAD, 3)).toBe(true);
    expect(f.gate.witnessSpent(HEAD, 0)).toBe(false);
    expect(f.gate.witnessSpent("b".repeat(40), 3)).toBe(false);
    f.time(60_000);
    expect(f.gate.witnessSpent("b".repeat(40), 3)).toBe(true);
    f.gate.resetWitness();
    expect(f.gate.witnessSpent("b".repeat(40), 3)).toBe(false);
  });

  for (const change of [
    { head: "b".repeat(40), pull: "open-pull", unchanged: true },
    { head: HEAD, pull: "open-pull", unchanged: false },
    { head: HEAD, pull: "new-review", unchanged: true },
  ]) {
    it("detects activity within the capped delay and restores immediate probing", async () => {
      const f = fixture();
      await f.arm();
      for (const now of [0, 20_000, 60_000]) {
        f.time(now);
        expect(await f.gate.skip(1, 180)).toBe("witness");
      }
      f.time(60_001);
      f.set(change);
      expect(await f.gate.skip(1, 180)).toBe("witness");
      f.time(120_000);
      expect(await f.gate.skip(1, 180)).toBeNull();
      await f.arm();
      f.set(change);
      expect(await f.gate.skip(1, 180)).toBeNull();
    });
  }
  it("ages the wait from when the evidence was read, not from remember()", async () => {
    const f = fixture();
    const before = await f.gate.prime();
    f.time(200_000); // live evaluation after the read
    f.gate.remember(HEAD, before, true);
    f.set({ head: HEAD, pull: "open-pull", unchanged: true });
    f.time(299_999);
    expect(await f.gate.skip(1, 180)).toBe("witness");
    f.time(300_000);
    expect(await f.gate.skip(1, 180)).toBeNull();
  });

  it("refuses to arm a wait the evaluation already outlasted", async () => {
    const f = fixture();
    const before = await f.gate.prime();
    f.time(300_000);
    f.gate.remember(HEAD, before, true);
    f.set({ head: HEAD, pull: "open-pull", unchanged: true });
    f.time(300_001);
    expect(f.reads()).toBe(1);
    expect(await f.gate.skip(1, 180)).toBeNull();
    expect(f.reads()).toBe(1);
  });

  it("never skips without an authoritative keep-waiting branch", async () => {
    const f = fixture();
    await f.gate.prime();
    expect(await f.gate.skip(0, 180)).toBeNull();
    expect(f.reads()).toBe(1);
  });

  it("skips unchanged witness waits and pending unrelated checks only", async () => {
    const f = fixture();
    await f.arm();
    expect(await f.gate.skip(1, 180)).toBe("witness");
    await f.arm(false);
    expect(await f.gate.skip(180, 180)).toBe("pending");
  });

  for (const [name, changed] of [
    ["failed conditional read", null],
    [
      "changed check, comment or timeline signal",
      { head: HEAD, pull: "open-pull", unchanged: false },
    ],
    [
      "changed head",
      { head: "b".repeat(40), pull: "open-pull", unchanged: true },
    ],
    [
      "changed pull including same-head closure or labels",
      { head: HEAD, pull: "different-pull", unchanged: true },
    ],
  ] as const) {
    it(`forces live reads on ${name}, then forgets the wait`, async () => {
      const f = fixture();
      await f.arm();
      f.set(changed);
      expect(await f.gate.skip(1, 180)).toBeNull();
      f.set({ head: HEAD, pull: "open-pull", unchanged: true });
      expect(await f.gate.skip(1, 180)).toBeNull();
    });
  }

  it("refreshes at the age bound without extending it on skipped ticks", async () => {
    const f = fixture();
    await f.arm();
    f.time(299_999);
    expect(await f.gate.skip(1, 180)).toBe("witness");
    f.time(300_000);
    expect(await f.gate.skip(1, 180)).toBeNull();
  });

  it("expires reuse when the conditional reads themselves cross the age bound", async () => {
    const f = fixture();
    await f.arm();
    f.time(299_999);
    f.delay(1);
    expect(await f.gate.skip(1, 180)).toBeNull();
  });

  it("forces live witnesses before giving up at the poll bound", async () => {
    const f = fixture();
    await f.arm();
    expect(await f.gate.skip(179, 180)).toBe("witness");
    expect(await f.gate.skip(180, 180)).toBeNull();
    await f.arm();
    expect(await f.gate.skip(180, 0)).toBe("witness");
  });

  it("does not arm if the head moved between priming and authoritative reads", async () => {
    const f = fixture();
    const before = await f.gate.prime();
    f.gate.remember("b".repeat(40), before, true);
    expect(await f.gate.skip(0, 180)).toBeNull();
  });

  it("clears a wait on resume and on a new authoritative evaluation", async () => {
    const f = fixture();
    await f.arm();
    f.gate.clear();
    expect(await f.gate.skip(1, 180)).toBeNull();
    await f.arm();
    await f.gate.prime();
    expect(await f.gate.skip(1, 180)).toBeNull();
  });

  it("keeps the driver skip branch free of terminal returns and ahead of full status", () => {
    // Verbatim pin of the orchestration boundary; behavioural probes above
    // test the gate. A missing/moved wiring must not leave those green.
    const driver = (name: string) =>
      readFileSync(
        new URL(`../scripts/lib/driver/${name}.ts`, import.meta.url),
        "utf8",
      );
    const roundStep = driver("round-step");
    const branch = `  const skippedFinalCi = await context.finalCiWait.skip(
    0,
    context.witnessWaitLimit,
  );
  if (skippedFinalCi !== null) {
    if (skippedFinalCi === "witness") context.witnessWaits += 1;
    await sleep(FINAL_CI_POLL_SECONDS);
    return "continue";
  }

  return null;
}`;
    expect(roundStep).toContain(branch);
    // The skip runs at the round boundary, before the round's full status.
    expect(roundStep).toContain(
      "const stage = await waitForRoundBoundary(context);\n    if (stage !== null) return stage;\n  }\n  const readRoundStatusResult = await readRoundStatus(",
    );
    const convergence = driver("convergence-ci");
    expect(convergence).toMatch(
      /const finalCiSignals = await context\.finalCiWait\.prime\(\);\n {2}const released = await releaseCiHold\(context, reviewedHead\);/,
    );
    expect(convergence).toMatch(
      /async function releaseCiHold\([^)]*\)[^{]*\{\n(?: {2}\/\/[^\n]*\n)* {2}const release = await run\(/,
    );
    expect(convergence).toContain(
      'context.finalCiWait.remember(reviewedHead, finalCiSignals, false);\n    await sleep(FINAL_CI_POLL_SECONDS);\n    return "continue";',
    );
    expect(convergence).toContain(
      'context.finalCiWait.remember(reviewedHead, finalCiSignals, true);\n  await sleep(FINAL_CI_POLL_SECONDS);\n  return "continue";',
    );
  });
});

it("default final-CI signals use conditional HTTP and invalidate waits on transport and resource changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "final-ci-transport-"));
  try {
    const fixtureEnv: typeof process.env = {
      ...process.env,
      GH_REPO: "fixture/repo",
    };
    delete fixtureEnv.GIT_DIR;
    delete fixtureEnv.GIT_WORK_TREE;
    delete fixtureEnv.GIT_COMMON_DIR;
    const init = Bun.spawnSync(["git", "init", "--quiet", dir], {
      cwd: dir,
      env: fixtureEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(init, 0, "hermetic fixture git init");
    writeFileSync(join(dir, "phase"), "open");
    writeFakeProgram(
      join(dir, "gh"),
      String.raw`#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const dir = process.env.FIXTURE_DIR;
const phase = readFileSync(dir + '/phase', 'utf8');
if (args[0] !== 'api' || !args.includes('-i')) process.exit(2);
const path = args.at(-1);
const pull = /\/pulls\/123$/.test(path);
const checks = path.includes('/check-runs');
const malformed = phase === 'malformed' && pull;
const tag = '"' + (pull && phase === 'closed' ? 'closed' : malformed ? 'malformed' : checks && phase === 'checks-changed' ? 'new-checks' : 'open') + '"';
let status = args.includes('If-None-Match: ' + tag) ? 304 : 200;
if (checks && phase === 'check-error') status = 500;
let body = pull ? {state: phase === 'closed' ? 'closed' : 'open', merged: false, head: {sha: '${HEAD}'}} : [];
if (malformed) body = null;
appendFileSync(dir + '/calls', JSON.stringify({args, status}) + '\n');
process.stdout.write('HTTP/2.0 ' + status + ' fixture\r\nEtag: ' + tag + '\r\n\r\n');
if (status === 200) process.stdout.write(JSON.stringify(body));
process.exit(status === 200 ? 0 : 1);
`,
    );
    const script = `
import { writeFileSync, readFileSync } from 'node:fs';
import { setSystemTime } from 'bun:test';
import { FinalCiWait } from ${JSON.stringify(resolve(import.meta.dir, "../scripts/lib/final-ci-wait.ts"))};
import { currentMs } from ${JSON.stringify(resolve(import.meta.dir, "../../../shared/time.ts"))};
const epoch = currentMs();
setSystemTime(epoch);
const gate = new FinalCiWait('123');
const phase = (value) => writeFileSync(process.env.FIXTURE_DIR + '/phase', value);
const arm = async (unwitnessed = true) => {
  phase('open');
  const before = await gate.prime();
  if (before === null) throw new Error('could not prime actual HTTP gate');
  gate.remember('${HEAD}', before, unwitnessed);
};
const results = [];
await arm();
results.push(await gate.skip(1, 180));
await arm(false);
results.push(await gate.skip(1, 180));
for (const change of ['checks-changed', 'check-error', 'malformed', 'closed']) {
  await arm();
  phase(change);
  results.push(await gate.skip(1, 180));
  phase('open');
  results.push(await gate.skip(1, 180));
}
const calls = () => readFileSync(process.env.FIXTURE_DIR + '/calls', 'utf8').trim().split('\\n').map(JSON.parse);
await arm();
const baseline = calls().length;
for (let tick = 0; tick < 300_000; tick += 10_000) {
  setSystemTime(epoch + tick);
  await gate.skip(1, 180);
}
const waiting = calls().slice(baseline);
setSystemTime();
console.log(JSON.stringify({results, traffic: waiting.length, primary: waiting.filter(c => c.status === 200).length}));
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: dir,
      env: {
        ...fixtureEnv,
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        FIXTURE_DIR: dir,
        JIG_GH_CACHE_DIR: join(dir, "cache"),
        JIG_GH_CACHE: "on",
        NODE_ENV: "test",
        AWAIT_ROUND_CHECKS_MAX_AGE: "300",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(result, 0, "final-CI real conditional transport");
    const evidence = JSON.parse(result.stdout.toString());
    expect(evidence.traffic).toBe(36);
    expect(evidence.traffic).toBeLessThan(30 * 6); // fixed ten-second probes
    expect(evidence.primary).toBe(0); // 304 still sends traffic
    expect(evidence.results).toEqual([
      "witness",
      "pending",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    const calls = readFileSync(join(dir, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; status: number });
    expect(calls.some((call) => call.status === 200)).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.status === 304 && call.args.includes('If-None-Match: "open"'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.status === 500 && call.args.at(-1)?.includes("/check-runs"),
      ),
    ).toBe(true);
    expect(calls[0]?.args).not.toContain('If-None-Match: "open"');
    const changedChecks = calls.filter(
      (call) =>
        call.args.at(-1)?.includes("/check-runs") && call.status === 200,
    );
    expect(changedChecks.length).toBeGreaterThan(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

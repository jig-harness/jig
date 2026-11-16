import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paceForge,
  claimForgeSlot,
  FORGE_SPACING_MS,
} from "../outbound/forge-pacing.ts";
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { currentMs } from "../time.ts";
import { systemClock } from "../clock.ts";
import { closeDatabase, openDatabase } from "../records/db.ts";
import { BUDGET_MIGRATIONS } from "../outbound/schema.ts";

const directories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    closeDatabase(join(directory, "budget.sqlite"));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("coordinates concurrent processes for one owner while another owner sends independently", async () => {
  const directory = temporaryDirectory("jig-pacing-process-");
  const path = join(directory, "budget.sqlite");
  const now = 1_000_000;
  // Migrate before the synchronized claim race so this checks send admission.
  expect(claimForgeSlot("seed", now, path).ok).toBe(true);
  const gate = join(directory, "gate");
  const owners = ["same", "same", "other"];
  const children = owners.map((owner, index) =>
    Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/forge-pacing-worker.ts"),
        path,
        owner,
        String(now),
        gate,
        join(directory, `ready-${index}`),
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  try {
    const deadline = currentMs() + 10_000;
    while (
      !owners.every((_, index) =>
        existsSync(join(directory, `ready-${index}`)),
      ) &&
      currentMs() < deadline
    )
      await systemClock.sleep(5);
    expect(
      owners.every((_, index) => existsSync(join(directory, `ready-${index}`))),
    ).toBe(true);
    writeFileSync(gate, "");
    await Promise.all(children.map((child) => expectSpawnExited(child, 0)));
    const results = await Promise.all(
      children.map(async (child) =>
        JSON.parse(await new Response(child.stdout).text()),
      ),
    );
    expect(results.slice(0, 2).sort((a, b) => a.value - b.value)).toEqual([
      { ok: true, value: 0 },
      { ok: true, value: FORGE_SPACING_MS },
    ]);
    expect(results[2]).toEqual({ ok: true, value: 0 });
    // Workers exit without releasing anything; their slots expire by time alone.
    expect(claimForgeSlot("same", now + FORGE_SPACING_MS - 1, path)).toEqual({
      ok: true,
      value: 1,
    });
    expect(claimForgeSlot("same", now + FORGE_SPACING_MS, path)).toEqual({
      ok: true,
      value: 0,
    });
  } finally {
    children.forEach((child) => {
      child.kill();
    });
    await Promise.all(children.map((child) => child.exited));
  }
});

it("spaces the same owner, keeps other owners independent, and expires abandoned slots", async () => {
  const path = join(temporaryDirectory("jig-pacing-"), "budget.sqlite");
  let now = 1_000_000;
  expect(claimForgeSlot("a", now, path)).toEqual({ ok: true, value: 0 });
  expect(claimForgeSlot("a", now, path)).toEqual({
    ok: true,
    value: FORGE_SPACING_MS,
  });
  expect(claimForgeSlot("b", now, path)).toEqual({ ok: true, value: 0 });
  now += FORGE_SPACING_MS;
  expect(claimForgeSlot("a", now, path)).toEqual({ ok: true, value: 0 });
});

it("does not change the budget connection's contention policy", () => {
  const path = join(temporaryDirectory("jig-pacing-timeout-"), "budget.sqlite");
  const budget = openDatabase({ path, migrations: BUDGET_MIGRATIONS });
  expect(budget.ok).toBe(true);
  if (!budget.ok) return;
  expect(claimForgeSlot("owner", 1_000_000, path)).toEqual({
    ok: true,
    value: 0,
  });
  expect(budget.value.query("PRAGMA busy_timeout").get()).toEqual({
    timeout: 10_000,
  });
});

it("does not claim after cancellation or the caller deadline", async () => {
  const sleeps: number[] = [];
  let now = 1000;
  const deps = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    claim: () => ({ ok: true as const, value: 200 }),
  };
  expect((await paceForge("a", 1050, undefined, deps))?.code).toBe(
    "too-costly",
  );
  expect(now).toBe(1050);
  expect(sleeps).toEqual([50]);
  const controller = new AbortController();
  controller.abort();
  expect((await paceForge("a", 2000, controller.signal, deps))?.code).toBe(
    "unreachable",
  );
  expect(sleeps).toEqual([50]);
});

it("sends when the pacing storage is unavailable, as the budget's does", async () => {
  const deps = {
    now: () => 1000,
    sleep: async () => undefined,
    claim: () => ({
      ok: false as const,
      failure: {
        code: "unreachable" as const,
        reason: "Cannot coordinate GitHub request starts",
        cause: { code: "SQLITE_CANTOPEN" },
      },
    }),
  };
  expect(await paceForge("a", 2000, undefined, deps)).toBeNull();
});

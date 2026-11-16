import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";

async function scenario(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "jig-pacing-transport-"));
  const path = join(directory, "budget.sqlite");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/forge-pacing-transport.ts"),
      path,
      name,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    await expectSpawnExited(child, 0);
    return JSON.parse(await new Response(child.stdout).text());
  } finally {
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}

it("cancels a queued transport call without sending or budget admission", async () => {
  const result = await scenario("cancel");
  expect(result.sends).toEqual([]);
  expect(result.before).toBe(0);
  expect(result.admissions).toBe(0);
  expect(result.result.held.code).toBe("unreachable");
});

it("checks the shared budget after pacing so a newly held owner sends nothing", async () => {
  const result = await scenario("changed-budget");
  expect(result.sends).toEqual([]);
  expect(result.before).toBe(0);
  expect(result.admissions).toBe(1);
  expect(result.result.held.code).toBe("rate-limited");
});

for (const name of ["primary", "secondary"]) {
  it(`keeps ${name} resets authoritative over the pacing interval`, async () => {
    const result = await scenario(name);
    expect(result.sends).toHaveLength(1);
    expect(result.sends[0]).toBeGreaterThan(0);
    expect(result.sends[0]).toBeLessThanOrEqual(1);
    expect(result.admissions).toBe(2);
    expect(result.second.held.code).toBe("rate-limited");
    expect(result.second.held.until).toBeGreaterThan(
      result.now + (name === "primary" ? 590_000 : 119_000),
    );
  });
}

for (const name of ["probe-cancel", "probe-deadline"]) {
  it(`ends a held probe wait on ${name === "probe-cancel" ? "caller cancellation" : "the call deadline"} without sending`, async () => {
    const result = await scenario(name);
    expect(result.sends).toHaveLength(1);
    expect(result.countBeforeRelease).toBe(1);
    expect(result.admissions).toBe(1);
    expect(result.result.held.code).toBe(
      name === "probe-cancel" ? "unreachable" : "too-costly",
    );
  });
}

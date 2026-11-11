import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the gate-set job's matrix runs every part of the gate set, every test shard once, with nothing to suppress a leg", async () => {
  const { PART_ENV, TEST_SHARD_ENV, PARTS } = await import("./gates.ts");
  const { load } = await import("js-yaml");
  type Step = {
    name?: string;
    run?: string;
    if?: unknown;
    env?: Record<string, string>;
  };
  const { jobs } = load(
    readFileSync(join(root, ".github/workflows/gates.yml"), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        strategy?: Record<string, unknown> & {
          matrix?: { include?: { part: string; shard?: string }[] };
        };
        steps: Step[];
        "continue-on-error"?: unknown;
      }
    >;
  };
  const job = jobs["gate-set"];
  if (job === undefined) throw new Error("no gate-set job");
  // Every leg must report: one failing leg may not cancel the others, and no
  // leg may fail without failing the job.
  expect(job.strategy?.["fail-fast"]).toBe(false);
  expect(job["continue-on-error"]).toBeUndefined();
  expect(job.steps.some((step) => "continue-on-error" in step)).toBe(false);
  const legs = job.strategy?.matrix?.include ?? [];
  expect(Object.keys(job.strategy?.matrix ?? {})).toEqual(["include"]);
  // One checks leg; the tests legs name every share of one total.
  expect(legs.filter((leg) => leg.part === "checks")).toEqual([
    { part: "checks" },
  ]);
  const shards = legs.filter((leg) => leg.part === "tests");
  const total = Number(shards[0]?.shard?.split("/")[1]);
  expect(total).toBeGreaterThan(1);
  expect(shards.map((leg) => leg.shard)).toEqual(
    Array.from({ length: total }, (_, i) => `${i + 1}/${total}`),
  );
  expect(legs.length).toBe(1 + total);
  expect(new Set(legs.map((leg) => leg.part))).toEqual(new Set(PARTS));
  // The leg's part and share reach the gate script from its matrix row.
  const gates = job.steps.filter((step) => step.run === "bun run gates");
  expect(gates.length).toBe(1);
  // The gate stage must execute in every matrix leg. A condition here could
  // silently skip every tests leg while leaving the matrix itself intact.
  expect(gates[0]?.if).toBeUndefined();
  expect(gates[0]?.env?.[PART_ENV]).toBe(`\${{ matrix.part }}`);
  expect(gates[0]?.env?.[TEST_SHARD_ENV]).toBe(`\${{ matrix.shard }}`);
});

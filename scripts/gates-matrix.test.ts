import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the gate-set job's matrix is the one the areas resolve, and the full one runs every part of the gate set, every test shard once, with nothing to suppress a leg", async () => {
  const { PART_ENV, TEST_SHARD_ENV, TEST_PATHS_ENV, PARTS } = await import(
    "./gates.ts"
  );
  const { fullMatrix } = await import("./area-validation.ts");
  const { GATE_SET_MATRIX } = await import("./gates-workflow-contract.ts");
  const { load } = await import("js-yaml");
  type Step = {
    id?: string;
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
        strategy?: Record<string, unknown> & { matrix?: unknown };
        outputs?: Record<string, string>;
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
  // The legs come from the change's resolution, written by the areas job.
  expect(job.strategy?.matrix).toBe(GATE_SET_MATRIX);
  expect(jobs.areas?.outputs?.matrix).toBe(
    "${{ steps.resolve.outputs.matrix }}",
  );
  const resolve = jobs.areas?.steps.find((step) => step.id === "resolve");
  expect(resolve?.run).toContain("bun scripts/change-areas.ts --base HEAD^1");
  expect(resolve?.run).toContain("bun scripts/change-areas.ts --all");
  // The full matrix: one checks leg; the tests legs name every share of one total.
  const legs = fullMatrix().include;
  expect(legs.filter((leg) => leg.part === "checks")).toEqual([
    { part: "checks" },
  ]);
  const shards = legs.filter((leg) => leg.part === "tests");
  const total = Number(shards[0]?.shard?.split("/")[1]);
  expect(total).toBeGreaterThan(1);
  expect(shards.map((leg) => leg.shard)).toEqual(
    Array.from({ length: total }, (_, i) => `${i + 1}/${total}`),
  );
  expect(shards.every((leg) => leg.paths === undefined)).toBe(true);
  expect(legs.length).toBe(1 + total);
  expect(new Set(legs.map((leg) => leg.part))).toEqual(new Set(PARTS));
  // The leg's part, share and directories reach the gate script from its matrix row.
  const gates = job.steps.filter((step) => step.run === "bun run gates");
  expect(gates.length).toBe(1);
  // The gate stage must execute in every matrix leg. A condition here could
  // silently skip every tests leg while leaving the matrix itself intact.
  expect(gates[0]?.if).toBeUndefined();
  expect(gates[0]?.env?.[PART_ENV]).toBe(`\${{ matrix.part }}`);
  expect(gates[0]?.env?.[TEST_SHARD_ENV]).toBe(`\${{ matrix.shard }}`);
  expect(gates[0]?.env?.[TEST_PATHS_ENV]).toBe(`\${{ matrix.paths }}`);
});

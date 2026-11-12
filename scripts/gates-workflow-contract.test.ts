import { expect, test } from "bun:test";
import { nightlyEnvAllowed } from "./gates-workflow-contract.ts";

const RESULTS = `\${{ runner.temp }}/nightly-results`;

test("a suite's job and step may set only the nightly's baseline variables, naming the checked baseline", () => {
  expect(nightlyEnvAllowed(undefined, "job", true)).toBe(true);
  expect(
    nightlyEnvAllowed({ JIG_NIGHTLY_JOB: "website (macos)" }, "job", true),
  ).toBe(true);
  expect(
    nightlyEnvAllowed(
      {
        JIG_NIGHTLY_BASELINE: ".config/nightly-baseline.yaml",
        JIG_NIGHTLY_RESULTS: RESULTS,
      },
      "step",
      true,
    ),
  ).toBe(true);
  for (const [env, scope] of [
    [{ JIG_NIGHTLY_JOB: "x", CI: "false" }, "job"],
    [{ JIG_NIGHTLY_BASELINE: ".config/nightly-baseline.yaml" }, "job"],
    [{ JIG_NIGHTLY_BASELINE: "everything-known.yaml" }, "step"],
    [{ JIG_NIGHTLY_RESULTS: RESULTS, BUN_OPTIONS: "--bail" }, "step"],
    [{ JIG_NIGHTLY_RESULTS: 1 }, "step"],
    ["JIG_NIGHTLY_JOB=x", "job"],
  ] as const)
    expect(nightlyEnvAllowed(env, scope, true)).toBe(false);
});

test("a contract that is not the nightly's takes no nightly variable", () => {
  expect(nightlyEnvAllowed(undefined, "step", false)).toBe(true);
  for (const [env, scope] of [
    [{ JIG_NIGHTLY_JOB: "x" }, "job"],
    [
      {
        JIG_NIGHTLY_BASELINE: ".config/nightly-baseline.yaml",
        JIG_NIGHTLY_RESULTS: RESULTS,
      },
      "step",
    ],
  ] as const)
    expect(nightlyEnvAllowed(env, scope, false)).toBe(false);
});

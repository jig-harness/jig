import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { run } from "./review-fixture.ts";

const script = resolve(import.meta.dir, "../scripts/summarize-lenses.ts");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function lens(
  id: string,
  runs: boolean,
  reason: string,
  version: number | null = 1,
) {
  return {
    id,
    version,
    source: "seed",
    file: `/plugin/lenses/${id}.md`,
    runs,
    reason,
  };
}

const SELECTION = {
  lenses: [
    lens(
      "jig.swallowed-failure",
      true,
      "src/a.ts:12 added line matches \\bcatch\\b",
    ),
    lens("jig.test-gap", true, "src/a.ts matched"),
    lens("jig.stale-comment", false, "no trigger matched"),
    lens("jig.type-invariants", false, "off"),
  ],
};

function finding(severity: string, evidence: string, line: number | null = 12) {
  return {
    lens: "jig.swallowed-failure@1",
    file: "src/a.ts",
    line,
    severity,
    confidence: "high",
    scenario: "The upstream call fails and the caller sees an empty list.",
    impact: "An outage reads as no orders.",
    fix: "Propagate the failure with its cause.",
    evidence,
  };
}

function summarize(input: Record<string, unknown>, ...flags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "lens summary "));
  scratch.push(dir);
  writeFileSync(join(dir, "input.json"), JSON.stringify(input));
  return run(dir, process.execPath, [
    script,
    join(dir, "input.json"),
    ...flags,
  ]);
}

function summary(input: Record<string, unknown>) {
  const result = summarize(input, "--json");
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout) as {
    tier3: string;
    lenses: string;
    verdict: string | null;
    findings: { effective: string; unverified: boolean }[];
  };
}

const EVIDENCE =
  "client.get at src/a.ts:11; its failure ends as the returned []";

test("the Lenses line lists each lens that ran with its findings, then each skipped one with its reason", () => {
  const result = summarize({
    selection: SELECTION,
    findings: [finding("WARNING", EVIDENCE), finding("CRITICAL", EVIDENCE, 20)],
    semantic: "NONE",
    tier1: "PASSED",
    tier2: "PASSED",
  });
  expectSpawnExit(result, 0);
  expect(result.stdout.split("\n").slice(0, 3)).toEqual([
    "Tier 3 (Semantic):      ⚠️ WARNINGS",
    "Lenses:  2 run, 2 skipped  (jig.swallowed-failure@1: 2 WARNING; jig.test-gap@1: none; jig.stale-comment: no trigger matched; jig.type-invariants: off)",
    "VERDICT: APPROVED WITH WARNINGS",
  ]);
  expect(result.stdout).toContain(
    "reported CRITICAL; capped, the lens is not promoted",
  );
});

test("a lens finding is capped at WARNING, and one with empty evidence is unverified INFO that changes no verdict", () => {
  const capped = summary({
    selection: SELECTION,
    findings: [finding("CRITICAL", EVIDENCE)],
    semantic: "APPROVED",
    tier1: "PASSED",
    tier2: "PASSED",
  });
  expect(capped.findings[0]).toMatchObject({
    effective: "WARNING",
    unverified: false,
  });
  expect([capped.tier3, capped.verdict]).toEqual([
    "⚠️ WARNINGS",
    "APPROVED WITH WARNINGS",
  ]);
  const unverified = summary({
    selection: SELECTION,
    findings: [finding("CRITICAL", "  ")],
    semantic: "APPROVED",
    tier1: "PASSED",
    tier2: "PASSED",
  });
  expect(unverified.findings[0]).toMatchObject({
    effective: "INFO",
    unverified: true,
  });
  expect([unverified.tier3, unverified.verdict]).toEqual([
    "✅ APPROVED",
    "APPROVED",
  ]);
  expect(unverified.lenses).toContain("jig.swallowed-failure@1: 1 INFO");
});

test("Tier 3 is N/A when no semantic trigger fired and no lens ran, and a rejection blocks", () => {
  const none = { lenses: SELECTION.lenses.map((l) => ({ ...l, runs: false })) };
  expect(
    summary({
      selection: none,
      semantic: "NONE",
      tier1: "PASSED",
      tier2: "PASSED",
    }),
  ).toMatchObject({ tier3: "⏭️ N/A", verdict: "APPROVED" });
  expect(
    summary({
      selection: SELECTION,
      semantic: "NONE",
      tier1: "PASSED",
      tier2: "PASSED",
    }),
  ).toMatchObject({ tier3: "✅ APPROVED", verdict: "APPROVED" });
  expect(
    summary({
      selection: SELECTION,
      findings: [finding("WARNING", EVIDENCE)],
      semantic: "REJECTED",
      tier1: "PASSED",
      tier2: "PASSED",
    }),
  ).toMatchObject({ tier3: "❌ REJECTED", verdict: "BLOCKED" });
});

test("the exit criteria: Tier 1 or a blocking Tier 2 blocks, Tier 2 warnings approve with warnings", () => {
  const clean = { selection: SELECTION, semantic: "APPROVED" };
  expect(summary({ ...clean, tier1: "BLOCKED", tier2: "PASSED" }).verdict).toBe(
    "BLOCKED",
  );
  expect(summary({ ...clean, tier1: "PASSED", tier2: "BLOCKED" }).verdict).toBe(
    "BLOCKED",
  );
  expect(
    summary({ ...clean, tier1: "PASSED", tier2: "WARNINGS" }).verdict,
  ).toBe("APPROVED WITH WARNINGS");
  expect(summary(clean).verdict).toBeNull();
});

test("a flag that runs no lens says so, and lenses run in one session say they shared a context", () => {
  const quick = summarize({ skipped_by: "--quick", semantic: "NONE" });
  expectSpawnExit(quick, 0);
  expect(quick.stdout).toBe(
    "Tier 3 (Semantic):      ⏭️ N/A\nLenses:  none run (--quick)\n",
  );
  expect(
    summary({ selection: SELECTION, runner: "same-session", semantic: "NONE" })
      .lenses,
  ).toStartWith(
    "Lenses:  2 run in the same session (one shared context), 2 skipped  (",
  );
});

test("the selection may be given as the path of the file the lens step saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "lens selection "));
  scratch.push(dir);
  writeFileSync(join(dir, "lenses.json"), JSON.stringify(SELECTION));
  expect(
    summary({ selection: join(dir, "lenses.json"), semantic: "NONE" }).lenses,
  ).toStartWith("Lenses:  2 run, 2 skipped  (");
});

test("a malformed input or a finding from a lens that did not run is refused", () => {
  const stray = summarize({
    selection: SELECTION,
    findings: [
      { ...finding("WARNING", EVIDENCE), lens: "jig.stale-comment@1" },
    ],
    semantic: "NONE",
  });
  expectSpawnExit(stray, 2);
  expect(stray.stderr).toContain("jig.stale-comment@1, which did not run");
  const both = summarize({
    selection: SELECTION,
    skipped_by: "--quick",
    semantic: "NONE",
  });
  expectSpawnExit(both, 2);
  const severity = summarize({
    selection: SELECTION,
    findings: [finding("BLOCKER", EVIDENCE)],
    semantic: "NONE",
  });
  expectSpawnExit(severity, 2);
  expect(severity.stderr).toContain(
    "severity must be one of CRITICAL, WARNING, INFO",
  );
});

/**
 * Jig's own decline ladder, `.config/review-triage.yaml`, run through the
 * shipped `triage-ladder.ts` the way a review pass runs it: the file
 * validates, late rounds keep blocker and high findings and the regressions
 * a pull request's own fixes caused, and decline docs, style and wording
 * findings of medium and low severity.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

const root = join(import.meta.dir, "..");
const config = join(root, ".config", "review-triage.yaml");
const script = join(
  root,
  "plugin/skills/resolve-review-comments/scripts/triage-ladder.ts",
);

interface Verdict {
  stance: string;
  band: string | null;
  armed: boolean;
  reply: string | null;
  anomalies: string[];
}

function verdict(finding: {
  round: number;
  severity: string;
  category: string;
  tier?: number;
  selfInflicted?: boolean;
  obligatory?: boolean;
}): Verdict {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      script,
      "--severity",
      finding.severity,
      "--tier",
      String(finding.tier ?? 3),
      "--category",
      finding.category,
      "--self-inflicted",
      String(finding.selfInflicted ?? false),
      "--round",
      String(finding.round),
      "--config",
      config,
      ...(finding.obligatory ? ["--obligatory"] : []),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(proc, 0);
  return JSON.parse(proc.stdout.toString()) as Verdict;
}

describe("Jig's .config/review-triage.yaml", () => {
  test("validates and arms from round 1", () => {
    const v = verdict({ round: 1, severity: "low", category: "style" });
    expect(v.anomalies).toEqual([]);
    expect(v.armed).toBe(true);
    expect(v.stance).toBe("accepted");
  });

  test("keeps blocker and high findings in a late round", () => {
    for (const severity of ["blocker", "high"])
      expect(verdict({ round: 9, severity, category: "docs" }).stance).toBe(
        "accepted",
      );
  });

  test("keeps a regression this pull request caused in a late round", () => {
    expect(
      verdict({
        round: 9,
        severity: "medium",
        category: "docs",
        selfInflicted: true,
      }).stance,
    ).toBe("accepted");
  });

  test("declines medium and low docs, style and wording findings late", () => {
    for (const round of [5, 9])
      for (const category of ["docs", "style", "drift"])
        for (const severity of ["medium", "low"]) {
          const v = verdict({ round, severity, category });
          expect([round, category, severity, v.stance]).toEqual([
            round,
            category,
            severity,
            "declined",
          ]);
          expect(v.reply).toContain("**wont-fix**");
        }
  });

  test("defers an obligatory declined finding rather than dropping it", () => {
    const v = verdict({
      round: 9,
      severity: "medium",
      category: "docs",
      obligatory: true,
    });
    expect(v.stance).toBe("declined");
    expect(v.reply).toContain("**deferred**");
  });

  test("keeps correctness findings through round 6, not after", () => {
    expect(
      verdict({ round: 6, severity: "medium", category: "correctness" }).stance,
    ).toBe("accepted");
    expect(
      verdict({ round: 7, severity: "medium", category: "correctness" }).stance,
    ).toBe("declined");
  });
});

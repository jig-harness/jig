import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DiffError, diffLines, unquote } from "../scripts/diff-lines.ts";
import {
  EffectiveDiffError,
  effectiveDiff,
  type Git,
  gitVersionProblem,
} from "../scripts/effective-diff.ts";
import { LensConfigError, parseLens } from "../scripts/lens-file.ts";
import {
  firstMatch,
  parseLensConfig,
  requireKnownIds,
  selectLens,
} from "../scripts/lens-selection.ts";
import { lensesLine, rate, tier3, verdict } from "../scripts/lens-verdict.ts";
import { options, refusal } from "../scripts/select-lenses.ts";
import { decode, renderText, summarize } from "../scripts/summarize-lenses.ts";

const seedFile = resolve(import.meta.dir, "../lenses/jig.swallowed-failure.md");
const seed = parseLens(readFileSync(seedFile, "utf8"), seedFile, "seed");

describe("diffLines", () => {
  test("numbers added and removed lines by their hunk's counts", () => {
    const diff =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2 @@ ctx\n-old one\n---- looks like a header\n+new\n\\ No newline at end of file\n";
    expect(diffLines(diff, new Set(["a.ts"])).get("a.ts")).toEqual({
      removed: [
        { number: 2, text: "old one" },
        { number: 3, text: "--- looks like a header" },
      ],
      added: [{ number: 2, text: "new" }],
    });
  });

  test("reads a deleted file by its old path and refuses a malformed hunk", () => {
    const deleted =
      "diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-throw x;\n";
    expect(
      diffLines(deleted, new Set(["gone.ts"])).get("gone.ts")?.removed,
    ).toEqual([{ number: 1, text: "throw x;" }]);
    const short = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1 @@\n-x\n";
    expect(() => diffLines(short, new Set(["a"]))).toThrow(DiffError);
    const orphan = "@@ -1 +1 @@\n-x\n+y\n";
    expect(() => diffLines(orphan, new Set(["a"]))).toThrow(DiffError);
  });

  test("unquotes git's C escapes, octal bytes included", () => {
    expect(unquote('"b/tab\\tq\\"\\303\\251\\\\.ts"')).toBe('b/tab\tq"é\\.ts');
    expect(() => unquote('"b/\\q"')).toThrow(DiffError);
  });
});

describe("the lens file", () => {
  test("the seed lens parses with its id, version, rules and evidence field", () => {
    expect(seed).toMatchObject({
      id: "jig.swallowed-failure",
      version: 1,
      lever: null,
      evidence: "absorbed-failures",
      source: "seed",
    });
    expect(seed.rules.length).toBeGreaterThan(0);
  });

  test("refuses a missing body section, a bad version and an unknown key", () => {
    const text = readFileSync(seedFile, "utf8");
    for (const broken of [
      text.replace("## Evidence", "## Proof"),
      text.replace("version: 1", "version: 0"),
      text.replace("lever: ~", "lever: ~\nposture: blocking"),
      text.replace("lever: ~", "lever: L-0001"),
    ])
      expect(() => parseLens(broken, "x.md", "seed")).toThrow(LensConfigError);
  });
});

describe("selection", () => {
  const files = ["src/a.ts"];
  const diff = new Map([
    ["src/a.ts", { added: [{ number: 4, text: "} catch {" }], removed: [] }],
  ]);

  test("the first matching line names the lens's reason", () => {
    expect(firstMatch(seed.trigger, "seed", files, diff)).toEqual({
      path: "src/a.ts",
      line: 4,
      side: "added",
      pattern: "\\bcatch\\b",
    });
    const config = parseLensConfig({ off: [seed.id] });
    expect(selectLens(seed, config, false, files, diff)).toMatchObject({
      runs: false,
      reason: "off",
    });
  });

  test("refuses a configuration that names no lens or holds an unknown key", () => {
    expect(() =>
      requireKnownIds([seed], parseLensConfig({ off: ["jig.none"] }), []),
    ).toThrow("review.lenses.off names jig.none");
    expect(() => parseLensConfig({ promoted: {} })).toThrow(LensConfigError);
    expect(() => parseLensConfig({ dir: "" })).toThrow(LensConfigError);
    expect(() => parseLensConfig({ triggers: [] })).toThrow(LensConfigError);
    expect(parseLensConfig(undefined)).toEqual({
      dir: null,
      off: [],
      triggers: {},
    });
  });
});

describe("the verdict", () => {
  const ran = [
    {
      id: seed.id,
      version: 1,
      source: "seed" as const,
      file: seedFile,
      runs: true,
      reason: "x",
    },
  ];
  const finding = rate({
    lens: "jig.swallowed-failure@1",
    file: "a.ts",
    line: 1,
    severity: "CRITICAL",
    confidence: "high",
    scenario: "s",
    impact: "i",
    fix: "f",
    evidence: "e",
  });

  test("caps a lens finding and turns it into warnings", () => {
    const outcome = {
      skippedBy: null,
      lenses: ran,
      sharedContext: false,
      findings: [finding],
    };
    expect(finding.effective).toBe("WARNING");
    expect(tier3("APPROVED", outcome)).toBe("⚠️ WARNINGS");
    expect(verdict("PASSED", "PASSED", tier3("APPROVED", outcome))).toBe(
      "APPROVED WITH WARNINGS",
    );
    expect(lensesLine(outcome)).toBe(
      "Lenses:  1 run, 0 skipped  (jig.swallowed-failure@1: 1 WARNING)",
    );
    expect(lensesLine({ ...outcome, lenses: [], findings: [] })).toBe(
      "Lenses:  0 run, 0 skipped",
    );
  });
});

describe("the effective diff", () => {
  test("reads the version git prints, on every platform's form", () => {
    expect(gitVersionProblem("git version 2.41.0\n")).toBeNull();
    expect(gitVersionProblem("git version 2.45.1.windows.1\n")).toBeNull();
    expect(gitVersionProblem("git version 3.0.0\n")).toBeNull();
    expect(gitVersionProblem("git version 2.39.3 (Apple Git-145)\n")).toContain(
      "2.39",
    );
    expect(gitVersionProblem("something else")).toContain("2.41 or later");
  });

  test("checks each call's status and refuses a comparison that printed no patch", async () => {
    const calls: string[][] = [];
    const answers: Record<string, { code: number; stdout: string }> = {
      tracked: { code: 0, stdout: "diff --git a/t b/t\n" },
      "new.ts": { code: 1, stdout: "diff --git a/new.ts b/new.ts\n" },
      "gone.ts": { code: 1, stdout: "" },
    };
    const git: Git = async (args, accept) => {
      calls.push(args);
      const answer =
        answers[args.at(-1) === "t" ? "tracked" : (args.at(-1) ?? "")];
      if (!answer || !accept.includes(answer.code))
        throw new EffectiveDiffError("refused");
      return answer;
    };
    expect(await effectiveDiff(git, "base", ["t"], ["new.ts"])).toBe(
      "diff --git a/t b/t\ndiff --git a/new.ts b/new.ts\n",
    );
    expect(calls[0]).toContain("--attr-source=base");
    expect(calls[1]).toContain("--attr-source=base");
    await expect(effectiveDiff(git, "base", [], ["gone.ts"])).rejects.toThrow(
      "could not compare gone.ts",
    );
  });
});

describe("the command lines", () => {
  test("select-lenses takes two files, --json and --lens=<id>, and names its refusals", () => {
    expect(options(["f", "d", "--json", "--lens=jig.x"])).toEqual({
      files: "f",
      diff: "d",
      json: true,
      forced: ["jig.x"],
    });
    expect(options(["f"])).toBeNull();
    expect(options(["f", "d", "--lens="])).toBeNull();
    expect(options(["f", "d", "e"])).toBeNull();
    expect(refusal(new LensConfigError("x"))).toBe(
      "select-lenses: configuration error: x",
    );
    expect(refusal(new DiffError("y"))).toBe("select-lenses: y");
    expect(refusal(new TypeError("z"))).toBeNull();
  });

  test("summarize-lenses renders the decoded input's lines", () => {
    const input = decode(
      JSON.stringify({
        selection: {
          lenses: [
            {
              id: seed.id,
              version: 1,
              source: "seed",
              file: seedFile,
              runs: true,
              reason: "x",
            },
          ],
        },
        findings: [
          {
            lens: "jig.swallowed-failure@1",
            file: "a.ts",
            line: null,
            severity: "WARNING",
            confidence: "low",
            scenario: "s",
            impact: "i",
            fix: "f",
            evidence: "",
          },
        ],
        semantic: "APPROVED",
        tier1: "PASSED",
        tier2: "PASSED",
      }),
    );
    expect(renderText(summarize(input))).toBe(
      "Tier 3 (Semantic):      ✅ APPROVED\nLenses:  1 run, 0 skipped  (jig.swallowed-failure@1: 1 INFO)\nVERDICT: APPROVED\n\nLens findings:\n- INFO  jig.swallowed-failure@1  a.ts (non-inline)  (unverified: its evidence field is empty; reported WARNING)\n  s\n  Impact: i\n  Confidence: low\n  Evidence: (empty)\n  Fix: f\n",
    );
    expect(() => decode("[")).toThrow("the input is not JSON");
    expect(() => decode("{}")).toThrow("give either selection or skipped_by");
    const base = { semantic: "NONE", skipped_by: "--quick" };
    expect(() =>
      decode(JSON.stringify({ ...base, findings: { severity: "CRITICAL" } })),
    ).toThrow("findings must be a list");
    expect(() =>
      decode(
        JSON.stringify({
          semantic: "NONE",
          selection: { lenses: [{ runs: true, reason: "x" }] },
        }),
      ),
    ).toThrow("without a valid id and version");
  });

  test("a repository lens's id is LENS-NNN", () => {
    expect(unquote('"a😀\\tb"')).toBe("a😀\tb");
    const text = `---\nid: foo\nversion: 1\nrules: []\nlever: ~\ntrigger:\n  paths: ["**"]\nevidence: e\n---\n\n## Look for\n## Not a finding\n## Evidence\n`;
    expect(() => parseLens(text, "f.md", "repository")).toThrow("LENS-NNN");
    expect(
      parseLens(text.replace("id: foo", "id: LENS-004"), "f.md", "repository")
        .id,
    ).toBe("LENS-004");
  });
});

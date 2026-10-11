/**
 * Suite for the STE linter (`scripts/ste-lint/ste-lint.ts`): a TypeScript
 * translation of the upstream Python linter (`--raw`) and of the local wrapper
 * that joins each wrapped paragraph or list item into one line before the
 * upstream rules measure sentence length (the default).
 *
 * The upstream linter measures one physical line at a time, so it misses every
 * long sentence in hard-wrapped Markdown. The join-step block pins that gap by
 * running the SAME text through both modes and expecting opposite results.
 *
 * Parity with the Python originals is pinned by golden files: each
 * `fixtures/ste-lint/<name>.{joined,raw}.json` is the Python linter's own
 * `--json` output for `<name>.md`, recorded when the linter was translated
 * (`scripts/migration-parity.md` § Simplified Technical English linter). The translation must reproduce
 * them byte for byte.
 *
 * The linter is advisory. The last describe blocks pin that no wiring file
 * names it, and that the canonical writing rules live in one file.
 */

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  type Finding,
  lint,
  main,
  pyRound1,
  splitlines,
  upstreamLint,
} from "../scripts/ste-lint/ste-lint.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const LINT_DIR = join(import.meta.dir, "../scripts/ste-lint");
const SCRIPT = join(LINT_DIR, "ste-lint.ts");
const FIXTURES = join(import.meta.dir, "fixtures/ste-lint");

/** The default mode, which `decide` runs. */
const JOINED: string[] = [];
/** The upstream linter alone. */
const UPSTREAM = ["--raw"];

/** Run the command line in process; stdin is `text`. */
function runCli(mode: string[], args: string[], stdin = "") {
  let stdout = "";
  const exitCode = main(
    [...mode, ...args],
    (text) => {
      stdout += text;
    },
    () => stdin,
  );
  return { exitCode, stdout };
}

/** Findings for `text` on stdin. Exit 1 means hard findings, which is not an error here. */
function lintText(mode: string[], text: string): Finding[] {
  const result = runCli(mode, ["--json"], text);
  expect([0, 1]).toContain(result.exitCode);
  return (JSON.parse(result.stdout) as { violations: Finding[] }).violations;
}

function countRules(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings)
    counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
  return counts;
}

/** Hard-wrap prose at `width`, keeping headings, tables and blank lines whole. */
function hardWrap(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim() || line.startsWith("#") || line.startsWith("|"))
        return line;
      const marker = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line)?.[1] ?? "";
      const indent = " ".repeat(marker.length);
      const words = line.slice(marker.length).split(/\s+/);
      const wrapped: string[] = [];
      let current = marker;
      for (const word of words) {
        if (current.trim() && current.length + 1 + word.length > width) {
          wrapped.push(current);
          current = indent + word;
        } else {
          current += (current.trim() ? " " : "") + word;
        }
      }
      wrapped.push(current);
      return wrapped.join("\n");
    })
    .join("\n");
}

const THIRTY_WORDS_OVER_THREE_LINES = [
  "The importer reads the export and then compares each stated",
  "shipping price with the matching rule in our catalogue so the",
  "reviewer can see every difference before the import runs.",
].join("\n");

describe("translated linter", () => {
  it("keeps the upstream MIT licence and attribution next to it", () => {
    const licence = readFileSync(join(LINT_DIR, "LICENSE"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Dustin Yuchen Teng");
  });

  it("passes the upstream selftest (--raw --selftest)", () => {
    const result = runCli(UPSTREAM, ["--selftest"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("selftest OK\n");
  });

  it("passes the wrapper selftest (upstream selftest first, then its own)", () => {
    const result = runCli(JOINED, ["--selftest"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("selftest OK\nselftest OK (joined)\n");
  });

  const goldens = readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) =>
      (["joined", "raw"] as const).map((mode) => ({ name, mode })),
    );

  it("has a golden output for every fixture in both modes", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(6);
    for (const { name, mode } of goldens)
      expect(
        existsSync(join(FIXTURES, name.replace(/\.md$/, `.${mode}.json`))),
      ).toBe(true);
  });

  it.each(goldens)(
    "reproduces the Python output for $name ($mode) byte for byte",
    ({ name, mode }) => {
      const golden = readFileSync(
        join(FIXTURES, name.replace(/\.md$/, `.${mode}.json`)),
        "utf8",
      );
      const proc = Bun.spawnSync(
        ["bun", SCRIPT, ...(mode === "raw" ? UPSTREAM : []), "--json", name],
        { cwd: FIXTURES, stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.stderr.toString()).toBe("");
      expect(proc.stdout.toString()).toBe(golden);
      const { hard_count: hardCount } = JSON.parse(golden) as {
        hard_count: number;
      };
      expect(proc.exitCode).toBe(hardCount > 0 ? 1 : 0);
    },
  );

  it.each(["joined", "raw"] as const)(
    "reads a CRLF file as Python's universal newlines do (%s)",
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "ste-lint-crlf-"));
      try {
        writeFileSync(
          join(directory, "crlf.md"),
          "Line one; with CRLF.\r\nThe report was sent by mail.\r\n- First item and\r\n",
        );
        const result = Bun.spawnSync(
          [
            "bun",
            SCRIPT,
            ...(mode === "raw" ? UPSTREAM : []),
            "--json",
            "crlf.md",
          ],
          { cwd: directory, stdout: "pipe" },
        );
        expect(result.stdout.toString()).toBe(
          readFileSync(join(FIXTURES, `crlf.${mode}.json`), "utf8"),
        );
        expect(result.exitCode).toBe(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("reads stdin, labels it <stdin>, and prints the text report", () => {
    const proc = Bun.spawnSync(["bun", SCRIPT], {
      stdin: Buffer.from("A; B."),
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout.toString()).toBe(
      "<stdin>:1:2 semicolon: STE bans the semicolon (Rule 8.1). Split into separate sentences. [;]\n" +
        "\n1 violations (1 hard, baseline 0), 2 words, 50.0 per 100 words\n" +
        "Hedges/modality (may, might, could) are never flagged: confidence is content.\n",
    );
  });

  it("honours --baseline and --disable as the Python linter does", () => {
    const text = "A; B; C.";
    expect(runCli(JOINED, ["--json"], text).exitCode).toBe(1);
    expect(runCli(JOINED, ["--json", "--baseline", "2"], text).exitCode).toBe(
      0,
    );
    const disabled = runCli(
      JOINED,
      ["--json", "--disable", "semicolon,x"],
      text,
    );
    expect(disabled.exitCode).toBe(0);
    expect(JSON.parse(disabled.stdout)).toEqual({
      violations: [],
      count: 0,
      hard_count: 0,
      baseline: 0,
      words: 3,
      per_100_words: 0,
    });
    expect(disabled.stdout).toContain('"per_100_words": 0.0');
  });

  it("fails with exit 1 on a missing file or a malformed baseline", () => {
    for (const args of [["no-such-file.md"], ["--baseline", "x", "-"]]) {
      const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
        stdin: Buffer.from(""),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toStartWith("ste-lint: ");
    }
  });

  it("counts columns and words as Python does: code points and Unicode whitespace", () => {
    const [findings, words] = upstreamLint("\u{1F600} x;\u2003y\u00a0z");
    expect(findings.map((f) => [f.rule, f.col])).toEqual([["semicolon", 4]]);
    expect(words).toBe(4);
    expect(splitlines("a\x1cb\u2028c\r\nd\n")).toEqual(["a", "b", "c", "d"]);
  });

  it("matches letters case-insensitively as Python does", () => {
    // Python's re.I matches dotless and dotted i, long s and the Kelvin sign.
    const rules = upstreamLint("\u0130s written. Was \u017fet.")[0].map(
      (f) => f.match,
    );
    expect(rules).toEqual(["\u0130s written", "Was \u017fet"]);
  });

  it("rounds the rate as Python's round(x, 1) does", () => {
    expect(pyRound1(1.95)).toBe(1.9);
    expect(pyRound1(0.25)).toBe(0.2);
    expect(pyRound1(0.75)).toBe(0.8);
    expect(pyRound1(2.25)).toBe(2.2);
  });
});

describe("join step", () => {
  it("fixture is 30 words over three lines, each line short enough to pass upstream", () => {
    const lines = THIRTY_WORDS_OVER_THREE_LINES.split("\n");
    expect(lines).toHaveLength(3);
    expect(THIRTY_WORDS_OVER_THREE_LINES.split(/\s+/)).toHaveLength(30);
    for (const line of lines)
      expect(line.split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it("flags a 30-word sentence hard-wrapped over three lines as long-sentence", () => {
    const findings = lintText(JOINED, THIRTY_WORDS_OVER_THREE_LINES);
    const long = findings.filter((f) => f.rule === "long-sentence");
    expect(long).toHaveLength(1);
    expect(long[0]?.match).toBe("30 words");
    expect(long[0]?.line).toBe(1);
  });

  it("the same fixture is invisible to the upstream linter alone", () => {
    const findings = lintText(UPSTREAM, THIRTY_WORDS_OVER_THREE_LINES);
    expect(findings.filter((f) => f.rule === "long-sentence")).toEqual([]);
  });

  it("flags a long sentence inside a hard-wrapped list item", () => {
    const item = `- ${THIRTY_WORDS_OVER_THREE_LINES.split("\n").join("\n  ")}`;
    const long = lintText(JOINED, item).filter(
      (f) => f.rule === "long-sentence",
    );
    expect(long).toHaveLength(1);
    expect(
      lintText(UPSTREAM, item).filter((f) => f.rule === "long-sentence"),
    ).toEqual([]);
  });

  // Each case below would produce a long-sentence finding if the wrapper
  // joined ACROSS the boundary under test, so removing a boundary check in
  // joinWrapped() turns exactly one of them red. Each half is 14 words.
  const half = (tag: string) =>
    Array.from({ length: 14 }, (_, i) => `${tag}${i}`).join(" ");
  const noLongSentence = (text: string) =>
    expect(
      lintText(JOINED, text).filter((f) => f.rule === "long-sentence"),
    ).toEqual([]);

  it("does not join across a blank line", () => {
    noLongSentence(`${half("a")}\n\n${half("b")}`);
  });

  it("does not join two list items into one sentence", () => {
    noLongSentence(`- ${half("a")}\n- ${half("b")}`);
  });

  it("does not join nested list items (any indent depth) into their parent", () => {
    noLongSentence(`- ${half("a")}\n  - ${half("b")}\n    - ${half("c")}`);
  });

  it("does not join list items inside a blockquote", () => {
    noLongSentence(`> - ${half("a")}\n> - ${half("b")}`);
  });

  it("does not join a heading into the paragraph after it", () => {
    noLongSentence(`# ${half("a")}\n${half("b")}`);
  });

  it("does not join table rows into one sentence", () => {
    const cell = (tag: string) =>
      Array.from({ length: 12 }, (_, i) => `${tag}${i}`).join(" ");
    noLongSentence(
      `| Label | Detail |\n| --- | --- |\n| ${cell("a")} | x |\n| ${cell("b")} | y |\n| ${cell("c")} | z |`,
    );
  });

  it("keeps a quoted paragraph apart from a table before it", () => {
    const cells = `${half("a")} | ${half("b")}`;
    const found = lintText(
      JOINED,
      `| A | B |\n| --- | --- |\n> | ${cells} |`,
    ).filter((f) => f.rule === "long-sentence");
    expect(found.map((f) => f.line)).toEqual([3]);
  });

  it("does not join a horizontal rule into its neighbours", () => {
    noLongSentence(`${half("a")}\n***\n${half("b")}`);
  });

  it("does not join front matter lines into one sentence", () => {
    noLongSentence(
      `---\ntitle: ${half("a")}\nnote: ${half("b")}\n---\n\nBody.`,
    );
  });

  it("does not join fenced code into prose", () => {
    noLongSentence(`\`\`\`\n${half("a")}\n${half("b")}\n\`\`\``);
  });

  it("still joins the continuation lines of one list item and one blockquote", () => {
    const item = `- ${half("a")}\n  ${half("b")}`;
    expect(
      lintText(JOINED, item).filter((f) => f.rule === "long-sentence"),
    ).toHaveLength(1);
    const quote = `> ${half("a")}\n> ${half("b")}`;
    expect(
      lintText(JOINED, quote).filter((f) => f.rule === "long-sentence"),
    ).toHaveLength(1);
  });

  it("keeps every other rule exactly as upstream reports it", () => {
    // The join feeds long-sentence only. Upstream finds a dangling conjunction
    // by item indent, so a joined copy of these would change its verdict.
    // synonym-rotation is the one rule the wrapper changes on purpose (below).
    for (const text of [
      "- Start the task and\n\n  record the result.",
      "    - code and",
      "- Confirm the target\n  and",
      "Check the file. Then verify it;\nconfirm twice. We have seen it.",
    ]) {
      const rest = (findings: Finding[]) =>
        findings.filter(
          (f) => f.rule !== "long-sentence" && f.rule !== "synonym-rotation",
        );
      expect(rest(lintText(JOINED, text)), text).toEqual(
        rest(lintText(UPSTREAM, text)),
      );
    }
  });

  it.each(["_ _ _", "* * *", "- - -", "***"])(
    'does not join across the thematic break "%s"',
    (rule) => {
      noLongSentence(`${half("a")}\n${rule}\n${half("b")}`);
    },
  );

  it("parses blockquote structure before it tests boundaries", () => {
    noLongSentence(`> ${half("a")}\n>\n> ${half("b")}`);
    noLongSentence(`> ${half("a")}\n> # Heading\n> ${half("b")}`);
    noLongSentence(`> ${half("a")}\n${half("b")}`);
    noLongSentence(`${half("a")}\n> ${half("b")}`);
  });

  it.each(["- ", "> ", "1. ", "> - "])(
    'does not count the marker "%s" as a word (25 words is not long)',
    (marker) => {
      const prose = Array.from({ length: 25 }, (_, i) => `w${i}`).join(" ");
      noLongSentence(`${marker}${prose}`);
    },
  );

  it("closes a fence only on the same character and at least the same length", () => {
    const code = "x = a; y = b";
    expect(
      lintText(JOINED, `\`\`\`\`\n\`\`\`\n${code}\n\`\`\`\n\`\`\`\`\nDone.`),
    ).toEqual([]);
    expect(
      lintText(JOINED, `\`\`\`\n~~~\n${code}\n~~~\n\`\`\`\nDone.`),
    ).toEqual([]);
    // text after a real closing fence is still linted
    expect(
      lintText(JOINED, "```\nx\n```\nOne; two.").map((f) => f.rule),
    ).toEqual(["semicolon"]);
  });

  it("keeps the original line number of the paragraph that holds a finding", () => {
    const text = "Intro line.\n\nFirst part;\nsecond part.";
    const findings = lintText(JOINED, text);
    expect(findings.map((f) => [f.rule, f.line])).toEqual([["semicolon", 3]]);
  });
});

describe("hedges are content, never findings", () => {
  it('"The request may have failed." produces no finding', () => {
    expect(lintText(JOINED, "The request may have failed.")).toEqual([]);
    expect(lintText(UPSTREAM, "The request may have failed.")).toEqual([]);
  });

  it("a hedge split across a wrap point still produces no finding", () => {
    expect(lintText(JOINED, "The request may have\nfailed.")).toEqual([]);
  });

  it.each([
    "The request may\nhave failed.",
    "The request may  have failed.",
    "The request may already have failed.",
    "The request may not yet have failed.",
  ])("keeps the hedge protected in %j", (text) => {
    expect(lintText(JOINED, text)).toEqual([]);
  });

  it("still flags a present perfect that no modal precedes", () => {
    expect(lintText(JOINED, "We have seen it.").map((f) => f.rule)).toEqual([
      "present-perfect",
    ]);
  });
});

describe("synonym rotation is advice, not a hard finding", () => {
  const text = "Validate the input. Confirm the choice.";

  it("upstream reports it as a hard finding", () => {
    expect(runCli(UPSTREAM, ["--json"], text).exitCode).toBe(1);
  });

  it("the wrapper reports the same finding as advice and exits 0", () => {
    const result = runCli(JOINED, ["--json"], text);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      hard_count: number;
      violations: Finding[];
    };
    expect(report.hard_count).toBe(0);
    expect(report.violations.map((f) => [f.rule, f.level])).toEqual([
      ["synonym-rotation", "advisory"],
    ]);
    expect(report.violations[0]?.message.match(/pick one/gi)).toHaveLength(1);
  });
});

describe("a decision text and its plain rewrite", () => {
  const original = readFileSync(join(FIXTURES, "A-original.md"), "utf8");
  const rewrite = readFileSync(
    join(FIXTURES, "B0-ste-rewrite-same-content.md"),
    "utf8",
  );

  it("A-original.md has 2 long sentences and 3 semicolons", () => {
    const counts = countRules(lint(original)[0]);
    expect(counts["long-sentence"]).toBe(2);
    expect(counts.semicolon).toBe(3);
  });

  it("B0-ste-rewrite-same-content.md has no long sentence", () => {
    const counts = countRules(lint(rewrite)[0]);
    expect(counts["long-sentence"]).toBeUndefined();
    expect(counts.semicolon).toBeUndefined();
  });

  it("A-original.md hard-wrapped at 80 columns gives the same counts", () => {
    const wrapped = hardWrap(original, 80);
    expect(wrapped.split("\n").length).toBeGreaterThan(
      original.split("\n").length,
    );
    const counts = countRules(lintText(JOINED, wrapped));
    expect(counts["long-sentence"]).toBe(2);
    expect(counts.semicolon).toBe(3);
  });

  it("the upstream linter alone loses the long sentences once the file is wrapped", () => {
    const counts = countRules(lintText(UPSTREAM, hardWrap(original, 80)));
    expect(counts["long-sentence"]).toBeUndefined();
  });
});

describe("advisory only", () => {
  // The guarantee is narrow on purpose: no wiring file NAMES the linter. A
  // script that a wiring file delegates to is not followed, so a helper that
  // runs the linter without the name appearing here is out of this scan's reach.
  /** Files that wire CI, hooks, gates or validation plans. None may mention the linter. */
  function wiringFiles(): string[] {
    const required = [
      "package.json",
      "scripts/gates.ts",
      ".config/groundwork-overlay.yaml",
      ".claude-plugin/marketplace.json",
      "plugin/.claude-plugin/plugin.json",
      "plugin/.codex-plugin/plugin.json",
    ];
    // Hook and settings files this repository may add later.
    const optional = [
      "lefthook.yml",
      "lefthook.yaml",
      ".lefthook.yml",
      ".claude/settings.json",
      "plugin/hooks/hooks.json",
      "mise.toml",
    ];
    const files = [
      ...required,
      ...optional.filter((path) => existsSync(join(REPO_ROOT, path))),
    ].map((path) => join(REPO_ROOT, path));
    const workflows = join(REPO_ROOT, ".github/workflows");
    for (const name of readdirSync(workflows))
      if (/\.ya?ml$/.test(name)) files.push(join(workflows, name));
    return files;
  }

  it("reads a non-empty set of CI, gate and hook files (so a clean scan is real)", () => {
    const files = wiringFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) expect(statSync(file).isFile()).toBe(true);
  });

  it("no workflow, gate, package script, plugin manifest or hook names the linter", () => {
    const offenders = wiringFiles().filter((file) =>
      /ste-lint/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });
});

describe("one canonical writing section, pointers elsewhere", () => {
  const CANONICAL = "plugin/skills/decide/references/human-call-elaboration.md";
  const ANCHOR =
    "human-call-elaboration.md#writing-rules-for-text-that-asks-a-human-to-decide";
  const SURFACES = ["plugin/skills/decide/SKILL.md"];
  /** One phrase per canonical rule. Each must live in the canonical file only. */
  const RULE_WORDING = [
    ["at most", "20 words"].join(" "),
    ["Use the", "active voice."].join(" "),
    ["Use no", "semicolons."].join(" "),
    ["Use no", "phrasal verbs"].join(" "),
    ["noun clusters to", "at most 3 words"].join(" "),
    ["Use one term", "for one concept"].join(" "),
    ["Use a list", "when 3 or more steps"].join(" "),
    ["Define each", "domain term once"].join(" "),
    ["Keep every", "hedge."].join(" "),
    ["Add no fact", "the source does not state."].join(" "),
    ["Use no", "marketing adjectives"].join(" "),
    ["Use the verb,", "not a noun made from it."].join(" "),
  ];
  const SKIP = new Set(["node_modules", ".git", ".context", "dist"]);

  function markdownUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) found.push(...markdownUnder(path));
      } else if (entry.name.endsWith(".md")) {
        found.push(path);
      }
    }
    return found;
  }

  it("the canonical file holds the section and the rule wording", () => {
    const text = readFileSync(join(REPO_ROOT, CANONICAL), "utf8");
    expect(text).toContain(
      "## Writing rules for text that asks a human to decide",
    );
    for (const wording of RULE_WORDING) expect(text).toContain(wording);
  });

  it("every surface that asks a human for a call links to that section", () => {
    for (const surface of SURFACES) {
      const text = readFileSync(join(REPO_ROOT, surface), "utf8");
      expect(text, surface).toContain(ANCHOR);
    }
  });

  it("the rule wording appears in the canonical file only", () => {
    const files = markdownUnder(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    for (const wording of RULE_WORDING) {
      const holders = files
        .filter((file) => readFileSync(file, "utf8").includes(wording))
        .map((file) => relative(REPO_ROOT, file).split(sep).join("/"));
      expect(holders, wording).toEqual([CANONICAL]);
    }
  });
});

describe("the command line", () => {
  it("refuses an unknown flag instead of linting without it", () => {
    for (const mode of [JOINED, UPSTREAM])
      for (const flag of ["--selftset", "--jsno"])
        expect(() => runCli(mode, [flag], "Plain text.")).toThrow(
          `unknown flag ${flag}`,
        );
  });

  it("refuses a flag where a value flag expects its value", () => {
    for (const mode of [JOINED, UPSTREAM])
      for (const flag of ["--disable", "--baseline"])
        expect(() => runCli(mode, [flag, "--jsno"], "Plain text.")).toThrow(
          `${flag} needs a value`,
        );
  });

  it("still accepts every documented flag", () => {
    expect(
      runCli(JOINED, ["--json", "--baseline", "0", "--disable", "x"], "Hi.")
        .exitCode,
    ).toBe(0);
    expect(runCli(UPSTREAM, ["--selftest"]).exitCode).toBe(0);
  });
});

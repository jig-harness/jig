// The voice check (check-voice.ts): the guide's caps applied to the linter's
// sentences, the counts the ratchet holds, and the gates' report. The planted
// sentence is the check's reason to exist: the ratchet must refuse it, with
// the sentence quoted, and pass once it is gone.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import {
  repo,
  scratch,
} from "../modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet-test-support.ts";
import {
  lint,
  MAX_WORDS as LINTER_MAX_WORDS,
  pySplit,
} from "../plugin/skills/decide/scripts/ste-lint/ste-lint.ts";
import {
  MAX_WORDS,
  sentences,
  VISITOR_DOCUMENTS,
  voiceFindings,
} from "./check-voice.ts";

const SCRIPT = join(import.meta.dir, "check-voice.ts");
const ROOT = join(import.meta.dir, "..");

const PLANT =
  "This planted sentence exists only to show that the voice check refuses a " +
  "change which raises the count of findings in a visitor document, so it " +
  "keeps going on and on until it finally reaches exactly forty words in all.";

const entries = (source: string) =>
  voiceFindings(source).hard.map((f) => f.entry);

/** Visitor documents with nothing the check counts. */
const CLEAN: Record<string, string> = {
  "README.md": "# Jig\n\nJig holds the work. A person merges.\n",
  "FACTORY.md": "# The factory\n\nWork enters in a standard form.\n",
  "FEATURES.md": "# What you get\n\nAn audit of where you stand.\n",
  "ROADMAP.md": "# Roadmap\n\nWhat is open, in order.\n",
};

/** The test's environment, without a merge-base marker a caller might have set. */
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "RATCHET_HISTORICAL"),
);

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd,
    env: { ...inherited, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function documents(files: Record<string, string>): string {
  const dir = scratch("check-voice-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("the guide's caps", () => {
  test("the planted sentence has 40 words", () => {
    expect(pySplit(PLANT).length).toBe(40);
  });

  test("a sentence over 30 words counts, quoted; one of 30 words does not", () => {
    const thirty = pySplit(PLANT).slice(0, MAX_WORDS).join(" ");
    expect(entries(`${thirty}.\n`)).toEqual([]);
    expect(entries(`Short one. ${PLANT}\n`)).toEqual([
      `long-sentence, 40 words: "${PLANT}"`,
    ]);
  });

  test("a sentence wrapped over several lines is measured whole, from its first line", () => {
    const wrapped = `Intro.\n\n${pySplit(PLANT).join("\n")}\n`;
    expect(voiceFindings(wrapped).hard).toEqual([
      { line: 3, entry: `long-sentence, 40 words: "${PLANT}"` },
    ]);
  });

  test("two semicolons in one sentence count once; one semicolon does not", () => {
    expect(entries("It reads; it decides.\n")).toEqual([]);
    expect(
      entries("It reads; it decides; it writes. Then it stops.\n"),
    ).toEqual([
      'semicolons, 2 in one sentence: "It reads; it decides; it writes."',
    ]);
  });

  test("passive voice is reported as advice and never counted", () => {
    const found = voiceFindings("The pull request was merged.\n");
    expect(found.hard).toEqual([]);
    expect(found.advice.map((f) => f.entry)).toEqual([
      'passive-voice: "was merged"',
    ]);
  });

  test("a code span stays in the quote and out of the words", () => {
    const words = pySplit(PLANT).slice(0, 29).join(" ");
    const source = `${words} \`bun scripts/check-voice.ts --list FACTORY.md\` now.\n`;
    expect(entries(source)).toEqual([]);
    const longer = `${words} more \`a b\` words.\n`;
    expect(entries(longer)).toEqual([
      `long-sentence, 31 words: "${words} more \`a b\` words."`,
    ]);
  });

  test("the linter's word rules count as it states them", () => {
    expect(entries("The tool is seamless.\n")).toEqual([
      'marketing-adjective: "The tool is seamless."',
    ]);
  });
});

describe("word-rule report context", () => {
  test.each([
    ["marketing-adjective", "The tool is seamless."],
    ["phrasal-verb", "Please spin up the tool."],
    ["nominalization", "We perform an analysis."],
  ])(
    "%s quotes its sentence in the ratchet growth report",
    (rule, sentence) => {
      const r = repo(CLEAN, {
        counters: [
          {
            name: "voice",
            format: "json",
            command: [process.execPath, SCRIPT, "--json"],
          },
        ],
        configs: [],
      });
      r.write("FACTORY.md", `Intro. ${sentence}\n`);
      const result = r.ratchet();
      expectSpawnExit(
        { exitCode: result.code, stdout: result.out, stderr: "" },
        1,
      );
      expect(result.out).toContain(`${rule}: "${sentence}"`);
    },
  );

  test.each([
    [
      "The tool is seamless. The service is seamless.",
      ["The tool is seamless.", "The service is seamless."],
    ],
    [
      "The tool is seamless. The service is\nseamless.",
      ["The tool is seamless.", "The service is seamless."],
    ],
    [
      "- The tool is seamless. The service is\n  seamless.",
      ["The tool is seamless.", "The service is seamless."],
    ],
    [
      "| The tool is seamless. | The service is seamless. |\n| --- | --- |",
      ["The tool is seamless.", "The service is seamless."],
    ],
    [
      "😀 `code` The tool is seamless. The service is seamless.",
      ["😀 `code` The tool is seamless.", "The service is seamless."],
    ],
  ])(
    "each occurrence quotes only its owning sentence: %s",
    (source, quotes) => {
      expect(
        entries(source).filter((entry) =>
          entry.startsWith("marketing-adjective:"),
        ),
      ).toEqual(quotes.map((quote) => `marketing-adjective: "${quote}"`));
    },
  );

  test("a wrapped word finding quotes the whole sentence", () => {
    expect(entries("Intro.\n\nThe tool is\nseamless for teams.\n")).toContain(
      'marketing-adjective: "The tool is seamless for teams."',
    );
  });

  test.each([
    ["Fine.\tseamless tool.", 'marketing-adjective: "seamless tool."'],
    ["- Intro. End and", 'dangling-conjunction: "End and"'],
    ["- Intro.\n  End and", 'dangling-conjunction: "End and"'],
    ["- Fine.\tseamless tool.", 'marketing-adjective: "seamless tool."'],
  ])("maps normalized and marker coordinates: %s", (source, entry) => {
    expect(entries(source)).toContain(entry);
  });
});

describe("the sentences are the linter's", () => {
  test("the dedicated long-sentence fixture exercises parity", () => {
    const ours = sentences(PLANT).filter((s) => s.words > LINTER_MAX_WORDS);
    expect(ours).toHaveLength(1);
    expect(
      lint(PLANT)[0]
        .filter((f) => f.rule === "long-sentence")
        .map((f) => f.match),
    ).toEqual(ours.map((s) => `${s.words} words`));
  });
  // At the linter's own cap, the sentence pass finds exactly the sentences
  // the linter's long-sentence rule finds, on the lines it reports them.
  test.each([...VISITOR_DOCUMENTS])("%s", (doc) => {
    const text = readFileSync(join(ROOT, doc), "utf8");
    const ours = sentences(text)
      .filter((s) => s.words > LINTER_MAX_WORDS)
      .map((s) => `${s.line}: ${s.words} words`);
    const linter = lint(text)[0]
      .filter((f) => f.rule === "long-sentence")
      .map((f) => `${f.line}: ${f.match}`);
    expect(ours).toEqual(linter);
  });
});

describe("the ratchet holds each document's count", () => {
  const wiring = {
    counters: [
      {
        name: "voice",
        format: "json",
        command: [process.execPath, SCRIPT, "--json"],
      },
    ],
    configs: [],
  };

  test("a planted 40-word sentence in FACTORY.md fails, the sentence quoted, and passes once removed", () => {
    const r = repo(CLEAN, wiring);
    r.write("FACTORY.md", `${CLEAN["FACTORY.md"]}\n${PLANT}\n`);
    const planted = r.ratchet();
    const failed = { exitCode: planted.code, stdout: planted.out, stderr: "" };
    expectSpawnExit(failed, 1, "planted");
    expect(planted.out).toContain("count grew: voice FACTORY.md: 0 → 1");
    expect(planted.out).toContain(`long-sentence, 40 words: "${PLANT}"`);
    r.write("FACTORY.md", CLEAN["FACTORY.md"] as string);
    const removed = r.ratchet();
    expectSpawnExit(
      { exitCode: removed.code, stdout: removed.out, stderr: "" },
      0,
      "removed",
    );
  });

  test("a document's count may fall, and another sentence in place of a fixed one passes", () => {
    const r = repo({ ...CLEAN, "FACTORY.md": `${PLANT}\n` }, wiring);
    r.write("FACTORY.md", `${PLANT.replace("forty", "40")}\n`);
    const replaced = r.ratchet();
    expectSpawnExit(
      { exitCode: replaced.code, stdout: replaced.out, stderr: "" },
      0,
      "replaced",
    );
    r.write("FACTORY.md", CLEAN["FACTORY.md"] as string);
    const fell = r.ratchet();
    expectSpawnExit(
      { exitCode: fell.code, stdout: fell.out, stderr: "" },
      0,
      "fell",
    );
  });
});

describe("the command line", () => {
  test("the gates' stage reports a count for every visitor document", () => {
    const dir = documents({ ...CLEAN, "ROADMAP.md": `${PLANT}\n` });
    const result = run(dir, []);
    expectSpawnExit(result, 0);
    for (const doc of VISITOR_DOCUMENTS)
      expect(result.stdout).toMatch(
        new RegExp(
          `${doc.replace(".", "\\.")} +${doc === "ROADMAP.md" ? 1 : 0} `,
        ),
      );
  });

  test("--json prints each document's entries for the ratchet", () => {
    const dir = documents({ ...CLEAN, "README.md": `${PLANT}\n` });
    const result = run(dir, ["--json"]);
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout)).toEqual({
      counts: {
        "README.md": { [`long-sentence, 40 words: "${PLANT}"`]: 1 },
        "FACTORY.md": {},
        "FEATURES.md": {},
        "ROADMAP.md": {},
      },
    });
  });

  test("--list prints each finding with its document and line", () => {
    const dir = documents({ ...CLEAN, "FEATURES.md": `# What\n\n${PLANT}\n` });
    const result = run(dir, ["--list", "FEATURES.md"]);
    expectSpawnExit(result, 0);
    expect(result.stdout).toBe(
      `FEATURES.md:3: long-sentence, 40 words: "${PLANT}"\n`,
    );
  });

  test("a missing visitor document cannot be checked, except at the merge base", () => {
    const { "ROADMAP.md": _, ...rest } = CLEAN;
    const dir = documents(rest);
    const stage = run(dir, []);
    expectSpawnExit(stage, 2, "stage");
    expect(stage.stderr).toContain("ROADMAP.md is missing");
    expectSpawnExit(run(dir, ["--json"]), 2, "head");
    const base = run(dir, ["--json"], { RATCHET_HISTORICAL: "1" });
    expectSpawnExit(base, 0, "merge base");
    expect(Object.keys(JSON.parse(base.stdout).counts)).toEqual([
      "README.md",
      "FACTORY.md",
      "FEATURES.md",
    ]);
  });

  test("an unknown document or flag is a usage error", () => {
    const dir = documents(CLEAN);
    expectSpawnExit(run(dir, ["--list", "GLOSSARY.md"]), 2, "document");
    expectSpawnExit(run(dir, ["--jsno"]), 2, "flag");
    expectSpawnExit(run(dir, ["--json", "--list"]), 2, "both");
    expectSpawnExit(run(dir, ["FACTORY.md"]), 2, "without --list");
  });
});

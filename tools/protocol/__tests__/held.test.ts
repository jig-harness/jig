import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkDriveExitPhrases } from "../chapters/drive-exits.ts";
import { MAILBOX } from "../chapters/mailbox.ts";
import { PR_LABELS } from "../chapters/pr-labels.ts";
import { COMMENT_MARKERS } from "../chapters/comment-markers.ts";
import { NEEDS_AND_ANSWERS } from "../chapters/needs-and-answers.ts";
import { STEWARD_RECORDS_CHAPTER } from "../chapters/steward-records.ts";
import { checkHeldPhrases } from "../held.ts";
import { cleanUp, put, tempDir } from "./fixture.ts";

afterAll(cleanUp);

const SECTION = "## Operational instruction\n\n";
const EXIT_11 = "Exit `11` on the lock";
const EXIT_13 = "Exit `13` on the lock";
const STOP = "run --command stop";

const exitPhrase = {
  file: "skill.md",
  text: EXIT_11,
  section: "## Operational instruction",
};
const stopPhrase = {
  file: "skill.md",
  text: STOP,
  section: "## Operational instruction",
  includeCodeExamples: true,
};

type Case = [source: string, problems: number];

/** Writes each source as the checked file and expects its problem count. */
function expectHeld(
  name: string,
  cases: Case[],
  phrase: {
    file: string;
    text: string;
    section: string;
    includeCodeExamples?: boolean;
  } = exitPhrase,
  chapter = "drive-exits",
) {
  const root = tempDir(name);
  for (const [source, problems] of cases) {
    put(root, "skill.md", source);
    expect(checkHeldPhrases(root, chapter, [phrase])).toHaveLength(problems);
  }
}

test("a held value must survive unchanged, including its operational context", () => {
  const root = tempDir("held");
  const phrases = [{ file: "skill.md", text: EXIT_11 }];
  for (const [source, problems] of [
    [`${EXIT_11}\n`, 0],
    [`${EXIT_13}\n`, 1],
    ["Exit `11` on some other branch\n", 1],
  ] as Case[]) {
    put(root, "skill.md", source);
    expect(checkHeldPhrases(root, "drive-exits", phrases)).toHaveLength(
      problems,
    );
  }
  const unreadable = checkHeldPhrases(root, "drive-exits", [
    { file: "missing.md", text: "value" },
  ]);
  expect(unreadable).toHaveLength(1);
  expect(unreadable[0]?.problem).toContain("could not be read");
  expect(unreadable[0]?.problem).toContain("ENOENT");
  expect(unreadable[0]?.remedy).toContain("read access");
});

test("a held value is checked in its declared operational section", () => {
  expectHeld("held-location", [
    [`${SECTION}${EXIT_11}\n\n## Other\n\n${EXIT_11}\n`, 0],
    [`${SECTION}${EXIT_13}\n\n## Other\n\n${EXIT_11}\n`, 1],
  ]);
});

test("held phrases ignore hidden Markdown comments and tolerate section layout changes", () => {
  expectHeld("held-rendered", [
    [`${SECTION}${EXIT_13} <!-- ${EXIT_11} -->\n`, 1],
    [`\n${SECTION}New context.\n\n${EXIT_11}\n`, 0],
  ]);
});

test("held phrases ignore fenced decoys and fenced headings", () => {
  expectHeld("held-fences", [
    [`${SECTION}${EXIT_13}\n\n\`\`\`sh\n${EXIT_11}\n\`\`\`\n`, 1],
    [
      `${SECTION}\`\`\`sh\n# Another section\n\`\`\`\n\n${EXIT_11}\n\n## Other\n\n${EXIT_11}\n`,
      0,
    ],
  ]);
});

test("held phrases ignore indented code and preserve excluded-block boundaries", () => {
  expectHeld("held-indented-code", [
    [`${SECTION}    ${EXIT_11}\n`, 1],
    [`${SECTION}Exit \`11\` on\n\`\`\`text\nthe lock\n\`\`\`\n`, 1],
    [`${SECTION}Exit \`11\` on\n\n~~~text\nexample\n~~~\n\nthe lock\n`, 1],
    [`${SECTION}${EXIT_11}\n\n    example\n`, 0],
  ]);
});

test("held phrases retain list continuations and inline-code comment tokens", () => {
  expectHeld("held-markdown-context", [
    [`${SECTION}${EXIT_11}\n\n1. Handle the refusal:\n\n    ${EXIT_13}\n`, 1],
    [`${SECTION}The opening token is \`<!--\`.\n\n${EXIT_13}\n`, 1],
    [`${SECTION}1. Handle the refusal:\n\n    ${EXIT_11}\n`, 0],
  ]);
});

test("held phrases ignore escaped delimiters, nested fences, and tab-indented code", () => {
  expectHeld("held-markdown-edge-cases", [
    [`${SECTION}An escaped \\\` marker.\n\n<!-- ${EXIT_11} -->\n`, 1],
    [
      `${SECTION}1. Example:\n\n    \`\`\`text\n    ${EXIT_11}\n    \`\`\`\n`,
      1,
    ],
    [`${SECTION}\t${EXIT_11}\n`, 1],
  ]);
});

test("held phrases parse code-span closers and nested-list dedents as prose", () => {
  expectHeld("held-nested-markdown", [
    [`${SECTION}The token is \`\\\\\`.\n\n<!-- ${EXIT_11} -->\n`, 1],
    [`${SECTION}10. Parent\n    - Child\n\n    ${EXIT_11}\n`, 0],
  ]);
});

test("held phrases keep comments in separate Markdown blocks from code spans", () => {
  const hidden = `<!-- ${EXIT_11} -->\n`;
  const boundaries = [
    "### Details",
    "> quote",
    "- item",
    "~~~text\n~~~",
    "---",
  ];
  expectHeld("held-block-context", [
    [`${SECTION}An unmatched \` delimiter.\n\n${hidden}`, 1],
    [`${SECTION}~~~text\n<!--\n~~~\n\n${EXIT_11}\n`, 0],
    [`${SECTION}An unmatched \` delimiter.\n \n${hidden}`, 1],
    [`${SECTION}An unmatched \`\` delimiter.\n${hidden}`, 1],
    ...boundaries.map(
      (b): Case => [`${SECTION}An unmatched \` delimiter.\n${b}\n${hidden}`, 1],
    ),
  ]);
});

test("held phrases preserve comment syntax in opted-in fenced examples", () => {
  expectHeld(
    "held-fenced-comment-example",
    [
      [`${SECTION}~~~text\n<!--\n~~~\n\n${STOP}\n`, 0],
      [
        `${SECTION}1. Example:\n\n    ~~~text\n    <!--\n    ~~~\n\n${STOP}\n`,
        0,
      ],
      [`${SECTION}<!--\n~~~text\n-->\n<!-- ${STOP} -->\n~~~\n`, 1],
    ],
    stopPhrase,
    "mailbox",
  );
});

test("held phrases recognize headings without backtracking over closing hashes", () => {
  expectHeld("held-heading-hashes", [
    [`## Operational instruction ###\n\n${EXIT_11}\n`, 0],
  ]);
});

test("held phrases reject duplicate visible copies in an operational section", () => {
  expectHeld("held-duplicate", [
    [`${SECTION}${EXIT_13}\n\nExample: ${EXIT_11}\n`, 1],
  ]);
});

test("held phrases accept either checkout line ending and still reject changed values", () => {
  const root = tempDir("held-line-endings");
  for (const sourceEnding of ["\n", "\r\n"]) {
    for (const phraseEnding of ["\n", "\r\n"]) {
      const phrases = [
        {
          file: "skill.md",
          text: `an \`ack\` of each${phraseEnding}directive it acted on`,
        },
      ];
      for (const [word, problems] of [
        ["ack", 0],
        ["done", 1],
      ] as const) {
        put(
          root,
          "skill.md",
          `an \`${word}\` of each${sourceEnding}directive it acted on${sourceEnding}`,
        );
        expect(checkHeldPhrases(root, "mailbox", phrases)).toHaveLength(
          problems,
        );
      }
    }
  }
});

const repo = resolve(import.meta.dir, "../../..");

test("the stable chapters reject changed operational mailbox, label and association values", () => {
  const root = tempDir("held-chapters");
  const driveFile = "plugin/skills/drive-pr/SKILL.md";
  const pickupFile = "plugin/skills/do-item/SKILL.md";
  const drive = readFileSync(resolve(repo, driveFile), "utf8");
  const pickup = readFileSync(resolve(repo, pickupFile), "utf8");
  put(root, driveFile, drive);
  put(root, pickupFile, pickup);
  for (const chapter of [MAILBOX, PR_LABELS, COMMENT_MARKERS])
    expect(chapter.check?.(root)).toEqual([]);
  for (const [before, after] of [
    ["--command hold-push", "--command hold-branch"],
    ["--command resume --target stop", "--command resume --target halt"],
    ["--generation <n>", "--sequence <n>"],
    ["an `ack` of each", "an `done` of each"],
    [
      "directive refuses the push (exit `17`",
      "directive refuses the push (exit `18`",
    ],
  ]) {
    put(root, driveFile, drive.replaceAll(before ?? "", after ?? ""));
    expect(MAILBOX.check?.(root)?.length).toBeGreaterThan(0);
  }
  put(
    root,
    driveFile,
    drive.replace(
      "A graceful stop exits `18`",
      "A graceful stop exits `19` <!-- A graceful stop exits `18` -->",
    ),
  );
  expect(MAILBOX.check?.(root)?.length).toBeGreaterThan(0);
  put(root, driveFile, drive.replaceAll("jig:hold", "jig:pause"));
  expect(PR_LABELS.check?.(root)?.length).toBeGreaterThan(0);
  put(
    root,
    pickupFile,
    pickup.replaceAll("do-item-pr: <PR URL>", "wrong-pr: <PR URL>"),
  );
  expect(COMMENT_MARKERS.check?.(root)?.length).toBeGreaterThan(0);
});

test("the steward records chapter rejects a changed kind, field, cause or bound in the skill's decision step", () => {
  const root = tempDir("held-steward");
  const file = "plugin/skills/steward/SKILL.md";
  const skill = readFileSync(resolve(repo, file), "utf8");
  put(root, file, skill);
  expect(STEWARD_RECORDS_CHAPTER.check?.(root)).toEqual([]);
  for (const [before, after] of [
    [
      "| `rearm` | `target`, `facts`, `class` |",
      "| `rearm` | `target`, `facts` |",
    ],
    ["| `order` | `targets` |", "| `order` | `targets`, `limit` |"],
    ["| `need` |", "| `frame` |"],
    ["`scope`, `crashed`\nor `unknown`", "`scope`, `deadline`\nor `unknown`"],
    ["in at most 600 characters", "in at most 800 characters"],
    ["Submit at most 100 records.", "Submit at most 50 records."],
  ]) {
    const changed = skill.replace(before ?? "", after ?? "");
    expect(changed).not.toBe(skill);
    put(root, file, changed);
    expect(STEWARD_RECORDS_CHAPTER.check?.(root)?.length).toBeGreaterThan(0);
  }
  // A copy of the phrase in a hidden comment does not stand in for the step's own.
  put(
    root,
    file,
    skill.replace(
      "Submit at most 100 records.",
      "Submit at most 50 records. <!-- Submit at most 100 records. -->",
    ),
  );
  expect(STEWARD_RECORDS_CHAPTER.check?.(root)?.length).toBeGreaterThan(0);
});

test("the drive exit gate checks immediate arm, finish-round, tree lease and push refusal branches", () => {
  const root = tempDir("held-drive-exits");
  const driveFile = "plugin/skills/drive-pr/SKILL.md";
  const pickupFile = "plugin/skills/do-item/SKILL.md";
  const drive = readFileSync(resolve(repo, driveFile), "utf8");
  put(root, pickupFile, readFileSync(resolve(repo, pickupFile), "utf8"));
  put(root, driveFile, drive);
  expect(checkDriveExitPhrases(root)).toEqual([]);
  for (const [before, after] of [
    ["exit `11` (single-instance lock)", "exit `13` (single-instance lock)"],
    ["Proceed only on exit `0`", "Proceed only on exit `3`"],
    [
      "`WORKTREE_UNCLEAN` notice, exit `3`",
      "`WORKTREE_UNCLEAN` notice, exit `0`",
    ],
    ["**exit `16`,\n  QUOTA_PARKED**", "**exit `1`,\n  QUOTA_PARKED**"],
    [
      "`drive.ts` refuses that re-arm itself (exit `16`)",
      "`drive.ts` refuses that re-arm itself (exit `1`)",
    ],
    ["exit `0` inside the window", "exit `3` inside the window"],
    [
      "| `11` | Another live **session in your tree**",
      "| `13` | Another live **session in your tree**",
    ],
    [
      "| `13` | Another live **working tree**",
      "| `11` | Another live **working tree**",
    ],
    [
      "| `11` | Another live session holds this working tree's tree lease",
      "| `13` | Another live session holds this working tree's tree lease",
    ],
    [
      "also refuses (exit `17`) while a mailbox",
      "also refuses (exit `18`) while a mailbox",
    ],
  ]) {
    put(root, driveFile, drive.replaceAll(before ?? "", after ?? ""));
    expect(checkDriveExitPhrases(root)).toHaveLength(1);
  }
});

test("held phrases classify comments and fences with one inline-code recognizer", () => {
  const fenced = `~~~text\n${STOP}\n~~~\n`;
  expectHeld(
    "held-one-recognizer",
    [
      // Backticks cannot shield a closer inside an open comment.
      [`${SECTION}<!--\n\`-->\`\n\n${fenced}`, 0],
      // A fence ends the paragraph, so an inline comment opener before it cannot
      // reach past it and the fence stays a code example.
      [`${SECTION}\\\`<!--\n${fenced}-->\n`, 0],
      // A span running across lines shields a comment opener inside it.
      [`${SECTION}Token \`first\nthen <!--\nlast\`.\n\n${fenced}`, 0],
      // A comment opener at a line start is an HTML block that ends the paragraph,
      // so it hides what follows until its closer.
      [`${SECTION}Token \`first\n<!--\nlast\`.\n\n${fenced}`, 1],
    ],
    stopPhrase,
    "mailbox",
  );
});

test("held phrases follow CommonMark paragraph interruption for code spans and HTML blocks", () => {
  expectHeld(
    "held-commonmark-blocks",
    [
      // A list that does not start at 1 cannot interrupt a paragraph, so the
      // multiline span keeps its comment opener and the instruction stays visible.
      [`${SECTION}Token \`first\n2. <!--\nlast\`.\n\n${EXIT_11}\n`, 0],
      // Mixed characters are no thematic break, so the span is not ended.
      [`${SECTION}Token \`first\n-_* <!--\nlast\`.\n\n${EXIT_11}\n`, 0],
      // An HTML block hides its comment from an unmatched delimiter before it.
      [
        `${SECTION}An unmatched \` delimiter.\n<div>\n<!-- ${EXIT_11} -->\n</div>\n`,
        1,
      ],
    ],
    exitPhrase,
    "mailbox",
  );
});

test("the needs and answers chapter rejects a changed answer form, limit or dispatcher option", () => {
  const root = tempDir("held-needs-and-answers");
  const driveFile = "plugin/skills/drive-pr/SKILL.md";
  const readme = "plugin/README.md";
  const drive = readFileSync(resolve(repo, driveFile), "utf8");
  const page = readFileSync(resolve(repo, readme), "utf8");
  put(root, driveFile, drive);
  put(root, readme, page);
  expect(NEEDS_AND_ANSWERS.check?.(root)).toEqual([]);
  for (const [before, after] of [
    ["`answer <key>: approve` for", "`answer <key>: accept` for"],
    [
      "`answer <key>: choose <option>` for",
      "`answer <key>: pick <option>` for",
    ],
    ["of at most 500 characters", "of at most 400 characters"],
    ["the first 12 hexadecimal", "the first 16 hexadecimal"],
  ]) {
    put(root, driveFile, drive.replaceAll(before ?? "", after ?? ""));
    expect(NEEDS_AND_ANSWERS.check?.(root)?.length).toBeGreaterThan(0);
  }
  put(root, driveFile, drive);
  for (const [before, after] of [
    ["| `launch` | **Clear the record**", "| `launch` | **Drop the record**"],
    ["**I'll handle it — hide this card**", "**Leave it to me**"],
  ]) {
    put(root, readme, page.replaceAll(before ?? "", after ?? ""));
    expect(NEEDS_AND_ANSWERS.check?.(root)?.length).toBeGreaterThan(0);
  }
});

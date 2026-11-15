import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkDriveExitPhrases } from "../chapters/drive-exits.ts";
import { MAILBOX } from "../chapters/mailbox.ts";
import { PR_LABELS } from "../chapters/pr-labels.ts";
import { COMMENT_MARKERS } from "../chapters/comment-markers.ts";
import { checkHeldPhrases } from "../held.ts";
import { cleanUp, put, tempDir } from "./fixture.ts";

afterAll(cleanUp);

test("a held value must survive unchanged, including its operational context", () => {
  const root = tempDir("held");
  const phrases = [{ file: "skill.md", text: "Exit `11` on the lock" }];
  put(root, "skill.md", "Exit `11` on the lock\n");
  expect(checkHeldPhrases(root, "drive-exits", phrases)).toEqual([]);
  put(root, "skill.md", "Exit `13` on the lock\n");
  expect(checkHeldPhrases(root, "drive-exits", phrases)).toHaveLength(1);
  put(root, "skill.md", "Exit `11` on some other branch\n");
  expect(checkHeldPhrases(root, "drive-exits", phrases)).toHaveLength(1);
  const unreadable = checkHeldPhrases(root, "drive-exits", [
    { file: "missing.md", text: "value" },
  ]);
  expect(unreadable).toHaveLength(1);
  expect(unreadable[0]?.problem).toContain("could not be read");
  expect(unreadable[0]?.problem).toContain("ENOENT");
  expect(unreadable[0]?.remedy).toContain("read access");
});

test("a held value is checked in its declared operational section", () => {
  const root = tempDir("held-location");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `11` on the lock\n\n## Other\n\nExit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `13` on the lock\n\n## Other\n\nExit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
});

test("held phrases ignore hidden Markdown comments and tolerate section layout changes", () => {
  const root = tempDir("held-rendered");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `13` on the lock <!-- Exit `11` on the lock -->\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "\n## Operational instruction\n\nNew context.\n\nExit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
});

test("held phrases ignore fenced decoys and fenced headings", () => {
  const root = tempDir("held-fences");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `13` on the lock\n\n```sh\nExit `11` on the lock\n```\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\n```sh\n# Another section\n```\n\nExit `11` on the lock\n\n## Other\n\nExit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
});

test("held phrases ignore indented code and preserve excluded-block boundaries", () => {
  const root = tempDir("held-indented-code");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\n    Exit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `11` on\n```text\nthe lock\n```\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `11` on the lock\n\n    example\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
});

test("held phrases retain list continuations and inline-code comment tokens", () => {
  const root = tempDir("held-markdown-context");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `11` on the lock\n\n1. Handle the refusal:\n\n    Exit `13` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nThe opening token is `<!--`.\n\nExit `13` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\n1. Handle the refusal:\n\n    Exit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
});

test("held phrases ignore escaped delimiters, nested fences, and tab-indented code", () => {
  const root = tempDir("held-markdown-edge-cases");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nAn escaped \\` marker.\n\n<!-- Exit `11` on the lock -->\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\n1. Example:\n\n    ```text\n    Exit `11` on the lock\n    ```\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\n\tExit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
});

test("held phrases parse code-span closers and nested-list dedents as prose", () => {
  const root = tempDir("held-nested-markdown");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nThe token is `\\\\`.\n\n<!-- Exit `11` on the lock -->\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\n10. Parent\n    - Child\n\n    Exit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
});

test("held phrases keep comments in separate Markdown blocks from code spans", () => {
  const root = tempDir("held-block-context");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nAn unmatched ` delimiter.\n\n<!-- Exit `11` on the lock -->\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
  put(
    root,
    "skill.md",
    "## Operational instruction\n\n~~~text\n<!--\n~~~\n\nExit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
});

test("held phrases recognize headings without backtracking over closing hashes", () => {
  const root = tempDir("held-heading-hashes");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction ###\n\nExit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toEqual([]);
});

test("held phrases reject duplicate visible copies in an operational section", () => {
  const root = tempDir("held-duplicate");
  const phrase = {
    file: "skill.md",
    text: "Exit `11` on the lock",
    section: "## Operational instruction",
  };
  put(
    root,
    "skill.md",
    "## Operational instruction\n\nExit `13` on the lock\n\nExample: Exit `11` on the lock\n",
  );
  expect(checkHeldPhrases(root, "drive-exits", [phrase])).toHaveLength(1);
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
      put(
        root,
        "skill.md",
        `an \`ack\` of each${sourceEnding}directive it acted on${sourceEnding}`,
      );
      expect(checkHeldPhrases(root, "mailbox", phrases)).toEqual([]);
      put(
        root,
        "skill.md",
        `an \`done\` of each${sourceEnding}directive it acted on${sourceEnding}`,
      );
      expect(checkHeldPhrases(root, "mailbox", phrases)).toHaveLength(1);
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

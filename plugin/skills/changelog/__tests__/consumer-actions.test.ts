import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote } from "../scripts/change-notes.ts";
import { checkBranch, checkNotes } from "../scripts/check.ts";
import {
  INSTRUCTION_MAX,
  readDeclaration,
  whitespaceTwins,
} from "../scripts/consumer-actions.ts";
import { KEEP_A_CHANGELOG } from "../scripts/formats.ts";
import {
  commit,
  git,
  jigYaml,
  KEEP_CHANGELOG,
  MANIFEST,
  repository,
  resolvedFor,
  temporary,
} from "./scratch.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "fixtures", "consumer-actions", "every-form.md"),
  "utf8",
);

/** A note with one `### Added` entry, `entry` written after `- `. */
const note = (entry: string): string =>
  `---\nrelease: minor\n---\n\n### Added\n\n- ${entry}\n`;

const errorsOf = (text: string): string[] =>
  parseNote("changes/x.md", text, KEEP_A_CHANGELOG).errors;

describe("the declaration's forms", () => {
  test("a note in every form reads, with no finding", () => {
    expect(errorsOf(FIXTURE)).toEqual([]);
  });

  test("each form reads as what it declares", () => {
    const parsed = parseNote("changes/x.md", FIXTURE, KEEP_A_CHANGELOG).note;
    const declared = [...(parsed?.sections.values() ?? [])]
      .flat()
      .map((item) => {
        const read = readDeclaration(item);
        if (!read.ok) throw new Error(read.failure.reason);
        return read.value?.declaration ?? null;
      });
    expect(declared).toEqual([
      {
        kind: "action",
        strength: "required",
        // In the order of the levels, whatever order the note names them in.
        levels: ["machine", "instructions"],
        instruction:
          "Remove the manual restart step from runbooks and point the plugin source at the current release.",
        hints: [
          { kind: "text", value: "restart the drive" },
          { kind: "plugin-source", value: "old" },
        ],
      },
      {
        kind: "action",
        strength: "advised",
        levels: ["configuration"],
        instruction: "Set `dispatch.labels.enabled` to keep them.",
        hints: [
          { kind: "config", value: "dispatch.labels", absent: true },
          { kind: "config", value: "review.bots", absent: false },
          { kind: "file", value: ".github/workflows/*.yml" },
          { kind: "plugin-source", value: "project-scope" },
        ],
      },
      { kind: "none" },
      { kind: "none" },
      {
        kind: "action",
        strength: "advised",
        levels: ["machine"],
        instruction: "Upgrade the plugin when it is convenient.",
        hints: [],
      },
      { kind: "retracts", id: "0.157.0#3fa9c2b1" },
      { kind: "retracts", id: "0.158.1#0a1b2c3d" },
      null,
    ]);
  });

  test("the description is the entry's text before the declaration, whitespace collapsed", () => {
    const read = readDeclaration(
      "- **Breaking:** The flag\n  is renamed. **Consumer action:** required at\n  configuration. Rename it.",
    );
    expect(read.ok && read.value?.description).toBe(
      "**Breaking:** The flag is renamed.",
    );
  });
});

describe("a malformed declaration fails", () => {
  const long = "x".repeat(INSTRUCTION_MAX + 1);
  for (const [entry, finding] of [
    [
      "Labels. **Consumer action:** required at repository. Set it.",
      "unknown level `repository`",
    ],
    [
      "Labels. **Consumer action:** mandatory at machine. Upgrade.",
      "unknown strength `mandatory`",
    ],
    [
      "Labels. **Consumer action:** required at machine. Upgrade. **Detect:** `grep:restart`.",
      "unknown hint kind `grep`",
    ],
    [
      "Labels. **Consumer action:** required at machine. Upgrade. **Detect:** `file:../x`.",
      "`../x` leaves the repository",
    ],
    [
      "Labels. **Consumer action:** required at machine. Upgrade. **Detect:** `file:/etc/passwd`.",
      "`/etc/passwd` leaves the repository",
    ],
    [
      "Labels. **Consumer action:** required at machine. Upgrade. **Detect:** `file:docs/../../x`.",
      "leaves the repository",
    ],
    [
      `Labels. **Consumer action:** required at machine. ${long}`,
      `the instruction is ${INSTRUCTION_MAX + 1} characters`,
    ],
    [
      "Labels. **Consumer action:** retracts 0.157#3fa9c2b1.",
      "`retracts` names one action id",
    ],
    [
      "Labels. **Consumer action:** retracts 0.157.0#XYZ.",
      "`retracts` names one action id",
    ],
    [
      "Labels. **Consumer action:** required. Upgrade.",
      "write `<strength> at <level>",
    ],
    [
      "Labels. **Consumer action:** required at machine, machine. Upgrade.",
      "names each level once",
    ],
    [
      "Labels. **Consumer action:** required at machine. Upgrade. **Detect:** text:restart.",
      "each a code span",
    ],
    [
      "Labels. **Consumer action:** required at machine. Upgrade. **Detect:** `plugin-source:git`.",
      "a plugin-source: hint is one of",
    ],
    [
      "Labels. **Consumer action:** required at configuration. Set it. **Detect:** `config:a..b`.",
      "a config: hint names a dotted key",
    ],
    ["Labels. **Detect:** `text:x`.", "follows a **Consumer action:**"],
    [
      "Labels. **Consumer action:** none. **Consumer action:** none.",
      "declares one **Consumer action:**",
    ],
    ["**Consumer action:** none.", "follows the entry's description"],
  ] as const)
    test(finding, () => {
      const errors = errorsOf(note(entry));
      expect(errors.join("\n")).toContain(finding);
      expect(errors.join("\n")).toContain("changes/x.md");
    });

  test("an instruction of exactly the cap reads", () => {
    const most = "x".repeat(INSTRUCTION_MAX);
    expect(
      errorsOf(
        note(`Labels. **Consumer action:** required at machine. ${most}`),
      ),
    ).toEqual([]);
  });
});

describe("one release's entries", () => {
  const entry = (wrap: string) => ({
    file: "changes/a.md",
    items: [
      `- Labels. **Consumer action:** required at${wrap}configuration. Set it.`,
    ],
  });

  test("two entries differing only in their declaration's whitespace fail; identical ones are one action", () => {
    expect(
      whitespaceTwins([entry(" "), { ...entry("\n  "), file: "changes/b.md" }]),
    ).toEqual([
      expect.stringContaining(
        "changes/a.md and changes/b.md: two entries of one release",
      ),
    ]);
    expect(
      whitespaceTwins([entry(" "), { ...entry(" "), file: "changes/b.md" }]),
    ).toEqual([]);
    // The same description with another declaration is another action.
    expect(
      whitespaceTwins([
        entry(" "),
        {
          file: "changes/b.md",
          items: [
            "- Labels. **Consumer action:** advised at configuration. Set it.",
          ],
        },
      ]),
    ).toEqual([]);
  });

  test("the branch check reads every waiting note as one release", () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "p.json": MANIFEST("1.2.0"),
      "changes/a.md": note(
        "Labels. **Consumer action:** required at configuration. Set it.",
      ),
    });
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        "changes/b.md": note(
          "Labels. **Consumer action:** required at\n  configuration. Set it.",
        ),
      },
      "b",
    );
    const findings = checkNotes({
      ...resolvedFor(root, {
        version: { files: [{ path: "p.json", key: "version" }] },
      }),
      releasePaths: [],
      notePaths: [],
      authors: true,
      base: "main",
    }).findings;
    expect(findings.join("\n")).toContain("differ only in whitespace");
  });
});

describe("a breaking entry without an action", () => {
  const BREAKING = note("**Breaking:** The `--out` flag is now `--output`.");
  const setup = (section: string) => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "p.json": MANIFEST("1.2.0"),
      ".config/jig.yaml": jigYaml(
        `  file: CHANGELOG.md\n  version:\n    files:\n      - { path: p.json, key: version }${section}`,
      ),
    });
    git(root, "checkout", "-qb", "work");
    return root;
  };
  const findings = (root: string) =>
    checkBranch(root, "main", { JIG_HOME: temporary("jig-home-") }).findings;

  test("fails where changelog.consumer_actions is on", () => {
    const root = setup("\n  consumer_actions: true");
    commit(root, { "changes/x.md": BREAKING }, "note");
    expect(findings(root)).toEqual([
      expect.stringContaining("is breaking, so it says what a consumer does"),
    ]);
  });

  test("passes once it declares one, `none` included", () => {
    const root = setup("\n  consumer_actions: true");
    commit(
      root,
      {
        "changes/x.md": note(
          "**Breaking:** The `--out` flag is now `--output`. **Consumer action:** required at instructions. Rename it in scripts.",
        ),
        "changes/y.md": note(
          "**Breaking** The unused `--old` flag is gone. **Consumer action:** none.",
        ),
      },
      "notes",
    );
    expect(findings(root)).toEqual([]);
  });

  test("passes where the setting is off or absent", () => {
    for (const section of ["", "\n  consumer_actions: false"]) {
      const root = setup(section);
      commit(root, { "changes/x.md": BREAKING }, "note");
      expect(findings(root), JSON.stringify(section)).toEqual([]);
    }
  });

  test("the base's setting counts, not the branch's", () => {
    const root = setup("");
    commit(
      root,
      {
        "changes/x.md": BREAKING,
        ".config/jig.yaml": jigYaml(
          "  file: CHANGELOG.md\n  consumer_actions: true\n  version:\n    files:\n      - { path: p.json, key: version }",
        ),
      },
      "turn it on",
    );
    expect(findings(root)).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scanScars } from "../scripts/scar-lint/check-descarring-scars";

const fix = (name: string) =>
  join(import.meta.dir, "fixtures", "scar-lint", name);
/** A repository whose configuration is `yaml`, for a run that reads it. */
function configured(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "scar-lint-"));
  mkdirSync(join(root, ".config"));
  writeFileSync(join(root, ".config", "jig.yaml"), yaml);
  return root;
}
/**
 * No test reads the configuration of the checkout it runs in: the lint reads
 * `docs.promoted_statuses` from the repository at JIG_CONSUMER_ROOT, and the
 * suite's preload points JIG_OVERLAY at a fixture overlay.
 */
const bare = configured("");
function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/scar-lint/check-descarring-scars.ts"),
      ...args,
    ],
    {
      env: {
        ...process.env,
        PROMOTED_STATUSES: "",
        ALLOWLIST: "",
        JIG_OVERLAY: "",
        JIG_CONSUMER_ROOT: bare,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = [result.stdout.toString(), result.stderr.toString()];
  return {
    code: result.exitCode,
    out,
    err,
    exitCode: result.exitCode,
    stdout: out,
    stderr: err,
  };
}

const cases: [number, string, string][] = [
  [0, "clean approved doc passes", "clean.md"],
  [1, "scarred approved doc fails", "scarred.md"],
  [0, "doc documenting scar syntax (masked) passes", "documents-syntax.md"],
  [0, "descar_allow doc passes", "allowed.md"],
];
for (const [want, label, file] of cases)
  test(label, () => {
    expect(run([fix(file)]).code).toBe(want);
  });

test("scars are found at every YAML line break", () => {
  for (const eol of ["\n", "\r\n", "\r"])
    expect(
      scanScars(
        ["---", "status: approved", "---", "- Addressed the comment.", ""].join(
          eol,
        ),
      ),
    ).toEqual(["4: - Addressed the comment."]);
});

test("a scarred doc's report names the lines", () => {
  const { out } = run([fix("scarred.md")]);
  expect(out).toContain("SCAR ");
  expect(out).toContain("~~30s~~");
  expect(out).not.toContain("NOTE —");
});

test("a named draft is reported NOT SCANNED, never as OK", () => {
  const { code, out } = run([fix("draft.md")]);
  expect(code).toBe(0);
  expect(out).toContain("NOT SCANNED — 1 named file(s) were not scanned");
  expect(out).toContain("this is not evidence they are clean");
  expect(out).toContain(fix("draft.md"));
  expect(out).not.toContain("OK —");
});

test("a mixed batch says OK for the scanned and lists the skipped", () => {
  const { code, out } = run([fix("clean.md"), fix("draft.md")]);
  expect(code).toBe(0);
  expect(out).toContain("OK — no scars in approved docs");
  expect(out).toContain("NOTE — 1 of the named file(s) were not scanned");
  expect(out).toContain(`    ${fix("draft.md")}`);
  expect(out).not.toContain(`    ${fix("clean.md")}`);
});

test("scars plus a skipped draft: the scar report and the same note, exit 1", () => {
  const { code, out } = run([fix("scarred.md"), fix("draft.md")]);
  expect(code).toBe(1);
  expect(out).toContain("SCAR ");
  expect(out).toContain("NOTE — 1 of the named file(s) were not scanned");
});

test("a full-tree run with drafts in it stays plain OK", () => {
  const { code, out } = run([], {
    DOCS_DIR: join(import.meta.dir, "fixtures", "scar-lint"),
  });
  // The fixture tree holds a scarred doc, so the run fails, but names no
  // file and so prints no NOTE.
  expect(code).toBe(1);
  expect(out).not.toContain("NOTE —");
  const clean = run([], {
    DOCS_DIR: join(import.meta.dir, "fixtures", "scar-lint"),
    ALLOWLIST: "scarred.md table-reviewer.md bare-reviewer.md",
  });
  expect(clean.code).toBe(0);
  expect(clean.out.trim()).toBe("OK — no scars in approved docs");
});

test("scanScars masks fenced and inline code, and anchors phrases to list items", () => {
  const text = [
    "The value ~~was~~ is.",
    "- Addressed the comment.",
    "Prose that says addressed in passing.",
    "```",
    "~~inside a fence~~",
    "```",
    "Inline `~~code~~` is masked.",
  ].join("\n");
  expect(scanScars(text)).toEqual([
    "1: The value ~~was~~ is.",
    "2: - Addressed the comment.",
  ]);
});

test("a table's first-cell reviewer attribution is a scar", () => {
  const result = run([fix("table-reviewer.md")]);
  expectSpawnExit(result, 1);
  expect(result.out).toContain(
    "| Reviewer: please clarify the cache TTL | open |",
  );
});

test("a reviewer attribution opening a paragraph, and a review bot's handle, are scars", () => {
  const result = run([fix("bare-reviewer.md")]);
  expectSpawnExit(result, 1);
  expect(result.out).toContain("Reviewer: the cache TTL needs a unit.");
  expect(result.out).toContain(
    "Raised by coderabbitai[bot] on the first round.",
  );
});

test("a bot's handle in a list item is a scar", () => {
  expect(scanScars("- Raised by coderabbitai[bot] once.")).toEqual([
    "1: - Raised by coderabbitai[bot] once.",
  ]);
});

test("a reviewer named as a role, a label or a field is not a scar", () => {
  const result = run([fix("mentions-reviewer.md")]);
  expectSpawnExit(result, 0);
  expect(result.out.trim()).toBe("OK — no scars in approved docs");
});

test("a status the lint is not told is promoted is not scanned", () => {
  const result = run([fix("active-scarred.md")]);
  expectSpawnExit(result, 0);
  expect(result.out).toContain(
    "NOT SCANNED — 1 named file(s) were not scanned",
  );
  expect(result.out).toContain("(their status is not approved)");
});

test("PROMOTED_STATUSES names the statuses that are scanned", () => {
  const env = { PROMOTED_STATUSES: "approved active" };
  const scarred = run([fix("active-scarred.md")], env);
  expectSpawnExit(scarred, 1);
  expect(scarred.out).toContain("SCAR ");
  expect(scarred.out).toContain("- Addressed the reviewer's concern");
  expect(scarred.out).toContain("1 approved or active doc(s) carry");
  const clean = run([fix("active-clean.md"), fix("draft.md")], env);
  expectSpawnExit(clean, 0);
  expect(clean.out).toContain("OK — no scars in approved or active docs");
  expect(clean.out).toContain("(their status is not approved or active)");
  expect(clean.out).toContain(`    ${fix("draft.md")}`);
  expectSpawnExit(run([fix("scarred.md")], env), 1);
});

test("docs.promoted_statuses in the repository's configuration is read", () => {
  const root = configured("docs:\n  promoted_statuses: [approved, active]\n");
  const result = run([fix("active-scarred.md")], {
    JIG_CONSUMER_ROOT: root,
    HOME: root,
  });
  expectSpawnExit(result, 1);
  expect(result.out).toContain("SCAR ");
});

test("PROMOTED_STATUSES takes precedence over the configuration", () => {
  const root = configured("docs:\n  promoted_statuses: [approved, active]\n");
  const result = run([fix("active-scarred.md")], {
    JIG_CONSUMER_ROOT: root,
    HOME: root,
    PROMOTED_STATUSES: "approved",
  });
  expectSpawnExit(result, 0);
  expect(result.out).toContain("NOT SCANNED");
});

test("a repository that sets nothing keeps approved as the only promoted status", () => {
  const root = configured("docs:\n  stale_after_days: 30\n");
  const result = run([fix("active-scarred.md"), fix("scarred.md")], {
    JIG_CONSUMER_ROOT: root,
    HOME: root,
  });
  expectSpawnExit(result, 1);
  expect(result.out).toContain(`SCAR ${fix("scarred.md")}`);
  expect(result.out).not.toContain(`SCAR ${fix("active-scarred.md")}`);
});

test("a malformed docs.promoted_statuses is refused with exit 2", () => {
  const root = configured("docs:\n  promoted_statuses: approved\n");
  const result = run([fix("clean.md")], {
    JIG_CONSUMER_ROOT: root,
    HOME: root,
  });
  expectSpawnExit(result, 2);
  expect(result.err).toContain("docs.promoted_statuses must be a list");
});

test("a malformed docs section is refused, not defaulted", () => {
  const root = configured("docs: [active]\n");
  const result = run([fix("clean.md")], {
    JIG_CONSUMER_ROOT: root,
    HOME: root,
  });
  expectSpawnExit(result, 2);
  expect(result.err).toContain("docs must be a mapping");
});

test("frontmatter is excluded before every check", () => {
  expect(
    scanScars(
      '---\ndescription: "~~literal~~"\nnotes:\n  - Reviewer: x\n---\nBody.\n',
    ),
  ).toEqual([]);
});

test("a reviewer label opens a paragraph after frontmatter or a heading", () => {
  expect(
    scanScars("---\nstatus: approved\n---\nReviewer: please fix this.\n"),
  ).toHaveLength(1);
  expect(scanScars("# Review\nReviewer: please fix this.\n")).toHaveLength(1);
});

test("a reviewer label on a soft-wrapped line is not a paragraph opening", () => {
  expect(scanScars("The fields include\nReviewer: the approver.\n")).toEqual(
    [],
  );
  expect(scanScars("Intro.\n\nReviewer: looks wrong.\n")).toHaveLength(1);
});

test("masking inline code does not manufacture an opening attribution", () => {
  expect(scanScars("`primary` Reviewer: selects an approver.\n")).toEqual([]);
  expect(
    scanScars("| `primary` Reviewer: selects an approver. | x |\n"),
  ).toEqual([]);
});

test("resolution phrasing counts only where it opens the item", () => {
  expect(scanScars("- Requests to unaddressed hosts fail.\n")).toEqual([]);
  expect(scanScars("- The concern is addressed by retries.\n")).toEqual([]);
  expect(scanScars("- Addressed: moved the guard.\n")).toHaveLength(1);
  expect(scanScars("- [x] **Good catch** on the guard.\n")).toHaveLength(1);
});

test("scar lint: a hyphenated prefix is not a bot account", () => {
  expect(scanScars("not-codex[bot] said")).toEqual([]);
  expect(scanScars("by codex[bot]")).toHaveLength(1);
});

test("scar lint: a double-backtick span is masked", () => {
  expect(scanScars("Use ``coderabbitai[bot]`` as the handle")).toEqual([]);
});

test("scar lint: a setext underline or thematic break opens a paragraph", () => {
  expect(scanScars("Review\n======\nReviewer: please fix this.")).toHaveLength(
    1,
  );
  expect(scanScars("Intro\n\n***\nReviewer: please fix this.")).toHaveLength(1);
  expect(scanScars("Reviewer is asked\nReviewer: soft wrap")).toEqual([]);
});

test("scar lint: only an equal-length backtick run closes a span", () => {
  expect(scanScars("Use `x``` coderabbitai[bot]``")).toHaveLength(1);
  expect(scanScars("Use ``x` coderabbitai[bot]``")).toEqual([]);
  expect(scanScars("Use ```x`` coderabbitai[bot]```")).toEqual([]);
  expect(scanScars("Use `x` then `y` codex[bot]")).toHaveLength(1);
});

test("scar lint: an equals-only line at the start is a paragraph, not an underline", () => {
  expect(scanScars("====\nReviewer: the approver.")).toEqual([]);
  expect(scanScars("***\n\n====\nReviewer: the approver.")).toEqual([]);
});

test("scar lint: an escaped backtick opens no span", () => {
  expect(scanScars("Raised by \\`coderabbitai[bot]\\`")).toHaveLength(1);
  expect(scanScars("Raised by \\\\`coderabbitai[bot]`")).toEqual([]);
});

test("scar lint: a code span may run across the lines of a paragraph", () => {
  expect(scanScars("Use `the handle\ncoderabbitai[bot]` here.")).toEqual([]);
  expect(scanScars("Use `the handle\n\ncoderabbitai[bot]` here.")).toHaveLength(
    1,
  );
});

test("scar lint: a span opened in one block does not reach into the next", () => {
  expect(scanScars("# Heading `\ncoderabbitai[bot]")).toHaveLength(1);
  expect(scanScars("Intro `\n> coderabbitai[bot]")).toHaveLength(1);
  expect(scanScars("> Use `the handle\n> coderabbitai[bot]` here.")).toEqual(
    [],
  );
});

test("scar lint: only a list numbered 1 interrupts a paragraph", () => {
  expect(scanScars("Use `the handle\n2. coderabbitai[bot]` here.")).toEqual([]);
  expect(
    scanScars("Use `the handle\n1. coderabbitai[bot]` here."),
  ).toHaveLength(1);
});

test("scar lint: a later item of an ordered list ends the previous item", () => {
  expect(
    scanScars("1. Use `the handle\n2. coderabbitai[bot]` here."),
  ).toHaveLength(1);
  expect(
    scanScars("1) Use `the handle\n2) coderabbitai[bot]` here."),
  ).toHaveLength(1);
});

test("scar lint: a block boundary inside a quote ends the paragraph", () => {
  expect(
    scanScars("> Use `the handle\n>\n> coderabbitai[bot]` here."),
  ).toHaveLength(1);
  expect(
    scanScars("> Use `the handle\n> # Heading\n> coderabbitai[bot]` here."),
  ).toHaveLength(1);
});

test("scar lint: text after a multiline span opens no prefix", () => {
  expect(
    scanScars("Use `the value\nsuffix` | Reviewer: the approver. | yes |"),
  ).toEqual([]);
  expect(
    scanScars("Use `the value\nsuffix` - Addressed: normal prose."),
  ).toEqual([]);
});

test("scar lint: an indented numeral continues an ordered item's paragraph", () => {
  expect(
    scanScars("1. Use `the handle\n   2. coderabbitai[bot]` here."),
  ).toEqual([]);
  expect(
    scanScars("1) Use `the handle\n   2) coderabbitai[bot]` here."),
  ).toEqual([]);
  expect(
    scanScars("1. Use `the handle\n  2. coderabbitai[bot]` here."),
  ).toHaveLength(1);
});

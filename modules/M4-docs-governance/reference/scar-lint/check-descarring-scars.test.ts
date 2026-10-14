import { expect, test } from "bun:test";
import { join } from "node:path";
import { scanScars } from "./check-descarring-scars";

const fix = (name: string) => join(import.meta.dir, "fixtures", name);
function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "check-descarring-scars.ts"),
      ...args,
    ],
    {
      env: { ...process.env, ALLOWLIST: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { code: result.exitCode, out: result.stdout.toString() };
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
    DOCS_DIR: join(import.meta.dir, "fixtures"),
  });
  // The fixture tree holds a scarred doc, so the run fails, but names no
  // file and so prints no NOTE.
  expect(code).toBe(1);
  expect(out).not.toContain("NOTE —");
  const clean = run([], {
    DOCS_DIR: join(import.meta.dir, "fixtures"),
    ALLOWLIST: "scarred.md",
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

import { afterAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { corpusOrder, parseArgs, rankable } from "../scripts/corpus-order.ts";
import { frontmatter, markdownFiles, s4Lines } from "../scripts/lib/docs.ts";
import { readingList } from "../scripts/reading-list.ts";

const root = mkdtempSync(join(tmpdir(), "descar-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Creating a symbolic link needs a privilege Windows grants only to
// administrators or in Developer Mode; without it symlinkSync throws EPERM.
// Probe once, with a directory and a file link as the walk test uses both.
const canSymlink = (() => {
  const probe = join(root, "symlink-probe");
  try {
    mkdirSync(join(probe, "dir"), { recursive: true });
    writeFileSync(join(probe, "file"), "");
    symlinkSync(join(probe, "dir"), join(probe, "dir-link"));
    symlinkSync(join(probe, "file"), join(probe, "file-link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

function doc(path: string, status: string, body: string, extra = ""): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\ntitle: x\nstatus: ${status}\n${extra}---\n${body}`);
  return full;
}

const plain = "a\nb\nc\nd\ne\nf\ng\n";
doc("docs/ops/runbook.md", "approved", "We previously used X.\nNow Y.\n");
doc("docs/ops/draft.md", "draft", plain);
doc("docs/guides/a.md", "approved", `${plain}It no longer applies.\n`);
doc(
  "docs/guides/allowed.md",
  "approved",
  "originally\n",
  "descar_allow: true\n",
);
doc("docs/review/process.md", "approved", "formerly\nformerly\n");
doc("docs/archive/old.md", "approved", "previously\n");
doc("docs/retrospection/s.md", "draft", "previously\n");
doc("docs/top.md", "approved", plain);
doc("docs/deprecated/d.md", "deprecated", "previously\n");

describe("frontmatter", () => {
  it("reads top-level scalars and strips quotes and comments", () => {
    expect(
      frontmatter('---\ntitle: "A: b"\nstatus: approved # promoted\n---\nbody'),
    ).toEqual({ title: "A: b", status: "approved" });
  });
  it("returns null without a closed frontmatter block", () => {
    expect(frontmatter("# no frontmatter")).toBeNull();
    expect(frontmatter("---\nstatus: approved\n")).toBeNull();
  });
});

describe("markdownFiles", () => {
  it("returns [] for a missing directory", () => {
    expect(markdownFiles(join(root, "nowhere"))).toEqual([]);
  });

  it.skipIf(!canSymlink)(
    "does not follow symbolic links, so the walk stays inside and ends",
    () => {
      const tree = join(root, "links");
      mkdirSync(join(tree, "docs/sub"), { recursive: true });
      mkdirSync(join(tree, "outside"), { recursive: true });
      writeFileSync(join(tree, "docs/sub/a.md"), "a");
      writeFileSync(join(tree, "outside/b.md"), "b");
      symlinkSync(join(tree, "docs"), join(tree, "docs/sub/loop"));
      symlinkSync(join(tree, "outside"), join(tree, "docs/out"));
      symlinkSync(join(tree, "outside/b.md"), join(tree, "docs/b.md"));
      expect(markdownFiles(join(tree, "docs"))).toEqual([
        join(tree, "docs/sub/a.md"),
      ]);
    },
  );

  // chmod 0o000 does not remove read access for root, nor on Windows.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws with the path when a directory cannot be read",
    () => {
      const locked = join(root, "locked/docs/private");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      try {
        expect(() => markdownFiles(join(root, "locked/docs"))).toThrow(locked);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe("S4 reading list", () => {
  it("matches archaeological wording, including a tracker key as a version marker", () => {
    const text =
      "Previously X.\nfine\n**Update:** y\nas of ABC-12 renamed\nno longer here";
    expect(s4Lines(text).map((hit) => hit.line)).toEqual([1, 3, 4, 5]);
    expect(
      s4Lines("fine\nas of #123 renamed\nissue #4").map((h) => h.line),
    ).toEqual([2]);
  });
  it("prints file:line: text", () => {
    const file = join(root, "docs/ops/runbook.md");
    expect(readingList([file])).toEqual([`${file}:5: We previously used X.`]);
  });
});

describe("corpus order", () => {
  const options = parseArgs([
    "--docs-dir",
    join(root, "docs"),
    "--allow",
    "docs/review/",
  ]);

  it("ranks subtrees by density, highest first, leaving out excluded and empty buckets", () => {
    const ranked = corpusOrder(options);
    expect(ranked.map((bucket) => bucket.name)).toEqual([
      "guides",
      "ops",
      "(root)",
    ]);
    expect(ranked[0]).toMatchObject({ hits: 1, lines: 12 });
  });

  it("counts drafts and promoted documents only", () => {
    expect(rankable("x.md", "---\nstatus: draft\n---\n", options)).toBe(true);
    expect(rankable("x.md", "---\nstatus: deprecated\n---\n", options)).toBe(
      false,
    );
    expect(rankable("x.md", "no frontmatter", options)).toBe(false);
  });

  it("accepts the repository's promoted statuses", () => {
    const custom = parseArgs(["--promoted", "active"]);
    expect(custom.promoted).toEqual(["active"]);
    expect(rankable("x.md", "---\nstatus: active\n---\n", custom)).toBe(true);
    expect(rankable("x.md", "---\nstatus: approved\n---\n", custom)).toBe(
      false,
    );
  });

  it("rejects an unknown option or a missing value", () => {
    expect(() => parseArgs(["--nope", "x"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--docs-dir"])).toThrow(/needs a value/);
  });
});

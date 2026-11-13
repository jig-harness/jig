/**
 * Which ignored content a rule accounts for: Jig's marked working files and
 * a tool's self-marked cache are set aside, each with its rule, and anything
 * else is named as content no rule accounts for.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CACHEDIR_TAG_SIGNATURE,
  HANDOFF_MACHINE_BLOCK,
} from "../../shared/disposable-mark.ts";
import { classifyIgnored } from "../kinds/worktree-ignored.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gc-ignored-marks-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if (path.endsWith("/")) mkdirSync(join(root, path), { recursive: true });
    else writeFileSync(join(root, path), content);
  }
  return root;
}
function classify(root: string, paths: string[]) {
  const result = classifyIgnored(root, paths);
  if (!result.ok) throw new Error(result.failure.reason);
  return result.value;
}
const TAG = `${CACHEDIR_TAG_SIGNATURE}\n# a cache\n`;
const HANDOFF = `# Drive handoff — PR #7\n\n${HANDOFF_MACHINE_BLOCK}\n\nnotes\n`;

describe("marked ignored content", () => {
  test("Jig's working files and a self-ignoring cache are set aside with their rules", () => {
    const root = tree({
      ".context/scratch/reply.md": "draft\n",
      ".context/drive-mailbox/CACHEDIR.TAG": TAG,
      ".context/drive-mailbox/inbox.jsonl": "{}\n",
      ".context/pr-drive-7.md": HANDOFF,
      ".context/empty/": "",
      ".fallow/.gitignore": "# written by the tool\n*\n",
      ".fallow/cache.bin": "x",
    });
    expect(classify(root, [".context/", ".fallow/"])).toEqual({
      rebuildable: [],
      setAside: [
        { path: ".context/drive-mailbox/", rule: "cache-tag" },
        { path: ".context/empty/", rule: "empty" },
        { path: ".context/pr-drive-7.md", rule: "drive-handoff" },
        { path: ".context/scratch/", rule: "jig-scratch" },
        { path: ".fallow/", rule: "self-ignoring" },
      ],
      other: [],
    });
  });

  test("content no rule accounts for is named beside what is set aside", () => {
    const root = tree({
      ".context/scratch/reply.md": "draft\n",
      ".context/msg.txt": "a person's note\n",
      ".context/facet-move/record.json": "{}\n",
      ".env": "SECRET=1\n",
    });
    expect(classify(root, [".context/", ".env"])).toEqual({
      rebuildable: [],
      setAside: [{ path: ".context/scratch/", rule: "jig-scratch" }],
      other: [".context/facet-move/", ".context/msg.txt", ".env"],
    });
  });

  test("a directory nothing inside accounts for stays one named entry", () => {
    const root = tree({ "notes/a.md": "a\n", "notes/deep/b.md": "b\n" });
    expect(classify(root, ["notes/"]).other).toEqual(["notes/"]);
  });

  test("paths git lists one by one inside a marked directory are set aside by it", () => {
    const root = tree({
      ".fallow/.gitignore": "*\n",
      ".fallow/cache.bin": "x",
      "cache/CACHEDIR.TAG": TAG,
      "cache/blob": "x",
    });
    expect(
      classify(root, [".fallow/.gitignore", ".fallow/cache.bin", "cache/blob"])
        .setAside,
    ).toEqual([
      { path: ".fallow/.gitignore", rule: "self-ignoring" },
      { path: ".fallow/cache.bin", rule: "self-ignoring" },
      { path: "cache/blob", rule: "cache-tag" },
    ]);
  });

  test("a mark that does not hold is no mark", () => {
    const root = tree({
      "unsigned/CACHEDIR.TAG": "not the signature\n",
      "unsigned/blob": "x",
      "partial/.gitignore": "*\n!keep.txt\n",
      "partial/keep.txt": "x",
      ".context/pr-drive-8.md": "# a note of the same name\n",
      "elsewhere/pr-drive-9.md": HANDOFF,
      "real-scratch/reply.md": "x",
      "tagged-target/CACHEDIR.TAG": TAG,
    });
    symlinkSync(join(root, "real-scratch"), join(root, ".context", "scratch"));
    symlinkSync(
      join(root, "tagged-target", "CACHEDIR.TAG"),
      join(root, "unsigned", "linked.TAG"),
    );
    mkdirSync(join(root, "linked-tag"));
    symlinkSync(
      join(root, "tagged-target", "CACHEDIR.TAG"),
      join(root, "linked-tag", "CACHEDIR.TAG"),
    );
    const content = classify(root, [
      "unsigned/",
      "partial/",
      ".context/",
      "elsewhere/",
      "linked-tag/",
    ]);
    expect(content.setAside).toEqual([]);
    expect(content.other).toEqual([
      "unsigned/",
      "partial/",
      ".context/",
      "elsewhere/",
      "linked-tag/",
    ]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a path that cannot be read is named, not a failed proof",
    () => {
      const root = tree({ "locked/inner/a.md": "a\n" });
      chmodSync(join(root, "locked"), 0o000);
      try {
        expect(classify(root, ["locked/", "gone/"]).other).toEqual([
          "locked/",
          "gone/",
        ]);
      } finally {
        chmodSync(join(root, "locked"), 0o700);
      }
    },
  );

  test("a dependency directory is still rebuildable beside the marks", () => {
    const root = tree({
      "package.json": "{}\n",
      "package-lock.json": "{}\n",
      "node_modules/pkg/index.js": "",
      ".context/scratch/x": "",
    });
    expect(classify(root, [".context/", "node_modules/"])).toEqual({
      rebuildable: ["node_modules/"],
      setAside: [{ path: ".context/scratch/", rule: "jig-scratch" }],
      other: [],
    });
  });
});

import { test, expect } from "bun:test";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIndex } from "./generate-index";

test("index fixture reproduces exactly and changed inputs make the gate fail", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-index-"));
  try {
    const docs = join(root, "docs");
    cpSync(join(import.meta.dir, "fixtures/docs"), docs, { recursive: true });
    expect(generateIndex(docs)).toBe(
      readFileSync(join(docs, "INDEX.md"), "utf8"),
    );
    const run = () =>
      Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "generate-index.ts"),
          "--check",
        ],
        {
          env: { ...process.env, DOCS_DIR: docs, OUT: join(docs, "INDEX.md") },
        },
      );
    expect(run().exitCode).toBe(0);
    writeFileSync(join(docs, "added.md"), "# Added\n");
    expect(run().exitCode).toBe(1);
    expect(readFileSync(join(docs, "INDEX.md"), "utf8")).not.toContain(
      "added.md",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

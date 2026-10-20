import { expect, test } from "bun:test";
import {
  mergeText,
  regressedHunks,
  staticChecks,
} from "../scripts/handback.ts";

test("overlapping round fixes remain conflicts", () => {
  const result = mergeText(
    "title: original\n",
    "title: accepted\n",
    "title: returned\n",
  );
  expect(result.conflict).toBe(true);
});
test("a re-applied old line reports the lost repository fix", () => {
  expect(
    regressedHunks("vendor: old\n", "vendor: neutral\n", "vendor: old\n")
      .length,
  ).toBe(1);
  expect(
    regressedHunks("vendor: old\n", "vendor: neutral\n", "vendor: neutral\n"),
  ).toEqual([]);
});
test("raw delivery fails text, duplicates, stale screenshot and unresolved review checks", () => {
  expect(
    staticChecks({
      files: {
        "index.html": "retired",
        "uploads/uploads/a.md": "a",
        "uploads/brief-a1b2c3d4.md": "a",
      },
      terms: ["retired"],
      readme: "",
      screenshotFresh: false,
      screenshotChanged: false,
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining("forbidden"),
      expect.stringContaining("nested"),
      expect.stringContaining("duplicate"),
      expect.stringContaining("newer"),
      expect.stringContaining("previous"),
      expect.stringContaining("Bar outcome"),
    ]),
  );
});
test("clean static delivery passes", () => {
  expect(
    staticChecks({
      files: { "index.html": "neutral" },
      terms: [],
      readme: "Bar outcome: pass",
      screenshotFresh: true,
      screenshotChanged: true,
    }),
  ).toEqual([]);
});

test("complete round keeps raw provenance, flags regressions and derives facts", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { expectSpawnExit } = await import(
    "../../../../lib/test-helpers/expect-spawn-exit.ts"
  );
  const dir = mkdtempSync(join(tmpdir(), "jig-round-"));
  const script = resolve(import.meta.dir, "../scripts/handback.ts");
  const exec = (argv: string[]) => {
    const p = Bun.spawnSync(argv, {
      cwd: dir,
      env: { ...process.env, JIG_CONSUMER_ROOT: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(p, 0);
    return p.stdout.toString().trim();
  };
  try {
    exec(["git", "init"]);
    exec(["git", "config", "user.email", "test@example.test"]);
    exec(["git", "config", "user.name", "Test"]);
    mkdirSync(join(dir, "bundle"));
    writeFileSync(join(dir, "bundle/README.md"), "Bar outcome: pass\n");
    writeFileSync(join(dir, "bundle/index.html"), "vendor: old\n");
    exec(["git", "add", "."]);
    exec(["git", "commit", "-m", "raw base"]);
    const base = exec(["git", "rev-parse", "HEAD"]);
    exec([
      process.execPath,
      script,
      "merge",
      "bundle",
      base,
      join(dir, "initial-staged"),
      "--ours",
      base,
    ]);
    expect(
      readFileSync(join(dir, "initial-staged/README.md"), "utf8"),
    ).toContain(
      "Previous export base provenance: first-added fallback (no recorded raw export)",
    );
    writeFileSync(
      join(dir, "bundle/README.md"),
      `Bar outcome: pass\nExport base: ${base}\n`,
    );
    writeFileSync(join(dir, "bundle/index.html"), "vendor: neutral\n");
    exec(["git", "add", "."]);
    exec(["git", "commit", "-m", "accepted fixes"]);
    const ours = exec(["git", "rev-parse", "HEAD"]);
    writeFileSync(join(dir, "bundle/index.html"), "vendor: old\n");
    exec(["git", "add", "."]);
    exec(["git", "commit", "-m", "raw returned"]);
    const raw = exec(["git", "rev-parse", "HEAD"]);
    exec([
      process.execPath,
      script,
      "merge",
      "bundle",
      raw,
      join(dir, "staged"),
      "--ours",
      ours,
    ]);
    expect(readFileSync(join(dir, "staged/index.html"), "utf8")).toBe(
      "vendor: neutral\n",
    );
    expect(readFileSync(join(dir, "staged/README.md"), "utf8")).toContain(
      `Export base: ${raw}`,
    );
    const report = JSON.parse(
      readFileSync(join(dir, "staged/handback-report.json"), "utf8"),
    );
    expect(report.previousExportBase).toBe(base);
    writeFileSync(
      join(dir, "entities.json"),
      JSON.stringify(["alpha", "beta", "gamma"]),
    );
    const command = JSON.stringify([
      process.execPath,
      "-e",
      'const entities = await Bun.file("entities.json").json(); console.log(JSON.stringify({entities: entities.length}))',
    ]);
    exec([process.execPath, script, "facts", command, join(dir, "facts.md")]);
    expect(readFileSync(join(dir, "facts.md"), "utf8")).toContain(
      '| "entities" | 3 |',
    );
    expect(readFileSync(join(dir, "facts.md"), "utf8")).toContain("Generated:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated unrelated text cannot conceal a reverted hunk", () => {
  expect(
    regressedHunks(
      "old\nkeep\nold\nnew\n",
      "new\nkeep\nold\nnew\n",
      "old\nkeep\nold\nnew\n",
    ),
  ).toHaveLength(1);
});
test("forbidden term directives do not flag their own declaration", () => {
  expect(
    staticChecks({
      files: {
        "README.md": "Forbidden terms: Retired Example\nBar outcome: pass",
      },
      terms: ["Retired Example"],
      readme: "Bar outcome: pass",
      screenshotFresh: true,
      screenshotChanged: true,
    }),
  ).toEqual([]);
});

test("deleted and added repository lines are reported when reverted", () => {
  expect(
    regressedHunks("retired\nkeep\n", "keep\n", "retired\nkeep\n"),
  ).toHaveLength(1);
  expect(regressedHunks("keep\n", "new\nkeep\n", "keep\n")).toHaveLength(1);
});

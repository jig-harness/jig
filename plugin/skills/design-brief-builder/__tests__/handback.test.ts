import { expect, test } from "bun:test";
import { parseManifest } from "../scripts/contracts.ts";
import {
  distinctPaths,
  mergeText,
  outcomeFailure,
  regressedHunks,
  staticChecks,
} from "../scripts/handback.ts";
import { decodePng, sameImage } from "../scripts/png.ts";
import { onePixel } from "./support.ts";

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
      "./bundle/",
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

test("a deleted line is checked on both sides of where it was", () => {
  // Without the merged===base shortcut: the merge changed a later line too.
  expect(
    regressedHunks(
      "first\nretired\nlast\n",
      "first\nlast\n",
      "first\nretired\nchanged-last\n",
    ),
  ).toHaveLength(1);
  expect(
    regressedHunks(
      "first\nretired\nlast\n",
      "first\nlast\n",
      "first\nlast\nadded\n",
    ),
  ).toEqual([]);
});
test("one operative bar outcome, outside comments and examples", () => {
  expect(outcomeFailure("Bar outcome: pass\n", "README")).toBeNull();
  for (const text of [
    "Bar outcome: fail\nBar outcome: pass\n",
    "Bar outcome: fail (two blockers)\nBar outcome: pass\n",
    "Bar outcome: pass (pending review)\n",
    "<!--\nBar outcome: pass\n-->\n",
    "```\nBar outcome: pass\n```\n",
    "Bar outcome: fail\n```md\nBar outcome: pass\n```\n",
    "   ```md\nBar outcome: pass\n   ```\n",
    "````\nBar outcome: pass\n```\nstill fenced\n````\n",
    "~~~\nBar outcome: pass\n",
  ])
    expect(outcomeFailure(text, "README")).not.toBeNull();
  for (const text of [
    "    ```\nBar outcome: pass\n",
    "```\nexample\n```\nBar outcome: pass\n",
    "``` not `a fence\nBar outcome: pass\n",
  ])
    expect(outcomeFailure(text, "README")).toBeNull();
});
test("screenshots compare as images, not bytes", () => {
  const white = onePixel([255, 255, 255]);
  const reencoded = onePixel([255, 255, 255], { level: 0 });
  expect(reencoded.equals(white)).toBe(false);
  expect(sameImage(decodePng(white), decodePng(reencoded))).toBe(true);
  expect(
    sameImage(decodePng(white), decodePng(onePixel([255, 255, 254]))),
  ).toBe(false);
  expect(() =>
    decodePng(Buffer.concat([white, Buffer.from("new export")])),
  ).toThrow("data after the image end");
  expect(() => decodePng(Buffer.from("not an image"))).toThrow("not a PNG");
});
test("scenario outputs stay distinct and out of the renderer's directory", () => {
  const manifest = (scenarios: object[]) =>
    JSON.stringify({ version: 1, scenarios });
  const scenario = (name: string, screenshot = `${name}.png`) => ({
    name,
    url: "index.html",
    ready: "main",
    screenshot,
  });
  expect(() => parseManifest(manifest([scenario("home")]))).not.toThrow();
  expect(() =>
    parseManifest(manifest([scenario("empty state"), scenario("empty/state")])),
  ).toThrow();
  expect(() =>
    parseManifest(
      manifest([scenario("home", ".handback-render/home-390.png")]),
    ),
  ).toThrow();
  expect(() =>
    parseManifest(manifest([{ ...scenario("home"), ready: undefined }])),
  ).toThrow();
  for (const screenshot of [
    "x/../.handback-render/home-390.png",
    "./.handback-render/home-390.png",
    "/tmp/home.png",
    "shots//home.png",
    "shots\\home.png",
  ])
    expect(() =>
      parseManifest(manifest([scenario("home", screenshot)])),
    ).toThrow();
  expect(() =>
    parseManifest(
      manifest([scenario("a", "./home.png"), scenario("b", "home.png")]),
    ),
  ).toThrow();
  expect(() =>
    parseManifest(manifest([scenario("home", "./shots/home.png")])),
  ).not.toThrow();
  // A case-insensitive file system stores each pair as one file.
  for (const scenarios of [
    [scenario("a", "shots/home.png"), scenario("b", "shots/HOME.png")],
    [scenario("home"), scenario("HOME", "other.png")],
    [scenario("a", "caf\u00e9.png"), scenario("b", "cafe\u0301.png")],
  ])
    expect(() => parseManifest(manifest(scenarios))).toThrow();
  for (const screenshot of [
    ".HANDBACK-RENDER/home-390.png",
    ".Handback-Render/shots/home.png",
  ])
    expect(() =>
      parseManifest(manifest([scenario("home", screenshot)])),
    ).toThrow();
});

test("a bundle has one path per file system identity", () => {
  expect(distinctPaths(["shots/home.png", "shots/away.png"], "b")).toEqual([
    "shots/home.png",
    "shots/away.png",
  ]);
  expect(() =>
    distinctPaths(["shots/home.png", "shots/HOME.png"], "b"),
  ).toThrow("shots/home.png and shots/HOME.png differ only in case");
  expect(() => distinctPaths(["caf\u00e9.png", "cafe\u0301.png"], "b")).toThrow(
    "differ only in case or Unicode normalization",
  );
});
test("the landing check finds a fix lost after the merge, until it is acknowledged", async () => {
  const {
    cpSync,
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { expectSpawnExit } = await import(
    "../../../../lib/test-helpers/expect-spawn-exit.ts"
  );
  const dir = mkdtempSync(join(tmpdir(), "jig-landing-"));
  const script = resolve(import.meta.dir, "../scripts/handback.ts");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("JIG_")),
    ),
    JIG_CONSUMER_ROOT: dir,
    JIG_USER_LAYER: "off",
  };
  const exec = (argv: string[], expected = 0) => {
    const p = Bun.spawnSync(argv, {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(p, expected);
    return p.stdout.toString().trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(resolve(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const landing = () =>
    JSON.parse(
      exec([
        process.execPath,
        "-e",
        `import { landingFailures } from ${JSON.stringify(script)}; console.log(JSON.stringify(landingFailures("bundle").failures))`,
      ]),
    ) as string[];
  try {
    exec(["git", "init"]);
    // Machine-read diffs must not take on the consumer's color settings.
    exec(["git", "config", "color.ui", "always"]);
    exec(["git", "config", "color.diff", "always"]);
    exec(["git", "config", "user.email", "test@example.test"]);
    exec(["git", "config", "user.name", "Test"]);
    write(
      ".config/jig.yaml",
      JSON.stringify({
        design_brief: {
          handback: {
            widths: [390],
            rubric: "rubric.md",
            scorecard: "scorecard.md",
            browser_executable: "unused-without-rendering",
          },
        },
      }),
    );
    write("rubric.md", "Review the scenario.\n");
    write("bundle/README.md", "Bar outcome: pass\n");
    write(
      "bundle/design-handback.json",
      JSON.stringify({
        version: 1,
        scenarios: [
          {
            name: "home",
            url: "index.html",
            ready: "main",
            screenshot: "home.png",
          },
        ],
      }),
    );
    write(
      "bundle/index.html",
      "<main>vendor: old</main>\n<p>a</p>\n<p>b</p>\n",
    );
    exec(["git", "add", "."]);
    exec(["git", "commit", "-m", "raw base"]);
    const base = exec(["git", "rev-parse", "HEAD"]);
    write("bundle/README.md", `Bar outcome: pass\nExport base: ${base}\n`);
    write(
      "bundle/index.html",
      "<main>vendor: neutral</main>\n<p>a</p>\n<p>b</p>\n",
    );
    exec(["git", "add", "."]);
    exec(["git", "commit", "-m", "accepted fixes"]);
    const ours = exec(["git", "rev-parse", "HEAD"]);
    write(
      "bundle/index.html",
      "<main>vendor: old</main>\n<p>a</p>\n<p>returned</p>\n",
    );
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
    rmSync(join(dir, "bundle"), { recursive: true });
    cpSync(join(dir, "staged"), join(dir, "bundle"), { recursive: true });
    write("scorecard.md", `Bar outcome: pass\nReviewed export base: ${raw}\n`);
    const reportPath = join(dir, "bundle/handback-report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.regressions).toEqual([]);
    expect(readFileSync(join(dir, "bundle/index.html"), "utf8")).toContain(
      "vendor: neutral",
    );
    const lost = (failures: string[]) =>
      failures.filter((f) =>
        f.startsWith("review lost repository hunk: index.html"),
      );
    expect(lost(landing())).toEqual([]);
    write(
      "bundle/index.html",
      "<main>vendor: old</main>\n<p>a</p>\n<p>returned</p>\n",
    );
    expect(lost(landing())).toHaveLength(1);
    const hunk = lost(landing())[0]?.slice(
      "review lost repository hunk: index.html: ".length,
    );
    report.regressions = [{ file: "index.html", hunk, acknowledged: true }];
    writeFileSync(reportPath, JSON.stringify(report));
    expect(lost(landing())).toEqual([]);
    write(
      "bundle/index.html",
      "<main>vendor: old</main>\n<p>a</p>\n<p>returned</p>\n\0",
    );
    expect(lost(landing())).toEqual([
      "review lost repository hunk: index.html: binary content differs from the repository version",
    ]);
    const reviewed = (failures: string[]) =>
      failures.filter((f) => f.startsWith("scorecard must record"));
    expect(reviewed(landing())).toEqual([]);
    for (const scorecard of [
      `Bar outcome: pass\nReviewed export base: ${base}\n<!-- Reviewed export base: ${raw} -->\n`,
      `Bar outcome: pass\nReviewed export base: ${base}\n\`\`\`\nReviewed export base: ${raw}\n\`\`\`\n`,
      `Bar outcome: pass\nReviewed export base: ${base}\nReviewed export base: ${raw}\n`,
      `Bar outcome: pass\nReviewed export base: ${base} (round 2)\nReviewed export base: ${raw}\n`,
    ]) {
      write("scorecard.md", scorecard);
      expect(reviewed(landing())).toHaveLength(1);
    }
    const readme = readFileSync(join(dir, "bundle/README.md"), "utf8");
    write(
      "bundle/README.md",
      `${readme}\n\`\`\`\nForbidden terms: example\n\`\`\`\nForbidden terms: vendor\nForbidden terms: returned\n`,
    );
    const forbidden = landing().filter((f) => f.startsWith("forbidden text"));
    expect(forbidden).toContain("forbidden text 'vendor': index.html");
    expect(forbidden).toContain("forbidden text 'returned': index.html");
    expect(forbidden.some((f) => f.includes("'example'"))).toBe(false);
    // The previous round's screenshot, now named in another spelling.
    writeFileSync(join(dir, "bundle/home.png"), onePixel([1, 2, 3]));
    exec(["git", "add", "bundle/home.png"]);
    exec(["git", "commit", "-m", "previous screenshot"]);
    const shot = exec(["git", "rev-parse", "HEAD"]);
    report.ours = shot;
    writeFileSync(reportPath, JSON.stringify(report));
    const manifest = (screenshot: string) =>
      write(
        "bundle/design-handback.json",
        JSON.stringify({
          version: 1,
          scenarios: [
            { name: "home", url: "index.html", ready: "main", screenshot },
          ],
        }),
      );
    manifest("HOME.png");
    const unchanged = (failures: string[]) =>
      failures.filter((f) => f.includes("differ from the previous round"));
    expect(unchanged(landing())).toHaveLength(1);
    writeFileSync(join(dir, "bundle/home.png"), onePixel([4, 5, 6]));
    expect(unchanged(landing())).toEqual([]);
    // A tree no file system can check out as two files is refused.
    const blob = exec(["git", "rev-parse", `${shot}:bundle/home.png`]);
    exec([
      "git",
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},bundle/Home.png`,
    ]);
    const aliasTree = exec(["git", "write-tree"]);
    exec(["git", "read-tree", "HEAD"]);
    report.ours = exec([
      "git",
      "commit-tree",
      aliasTree,
      "-p",
      shot,
      "-m",
      "alias",
    ]);
    writeFileSync(reportPath, JSON.stringify(report));
    const aliased = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { landingFailures } from ${JSON.stringify(script)}; landingFailures("bundle")`,
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(aliased, 1);
    expect(aliased.stderr.toString()).toContain(
      "bundle/Home.png and bundle/home.png differ only in case",
    );
    report.ours = shot;
    writeFileSync(reportPath, JSON.stringify(report));
    write(
      ".config/jig.yaml",
      JSON.stringify({
        design_brief: {
          handback: {
            widths: [390, 1280],
            rubric: "rubric.md",
            scorecard: "scorecard.md",
            browser_executable: "unused-without-rendering",
          },
        },
      }),
    );
    write(
      "bundle/design-handback.json",
      JSON.stringify({
        version: 1,
        scenarios: [
          {
            name: "a",
            url: "index.html",
            ready: "main",
            screenshot: "home.png",
          },
          {
            name: "b",
            url: "index.html",
            ready: "main",
            screenshot: "HOME-1280.png",
          },
        ],
      }),
    );
    const collision = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { landingFailures } from ${JSON.stringify(script)}; landingFailures("bundle")`,
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(collision, 1);
    expect(collision.stderr.toString()).toContain(
      "both resolve to HOME-1280.png",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

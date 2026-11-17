import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { footprintBody, readFootprint } from "../../../shared/footprint.ts";
import { predictionRecord } from "../scripts/lib/footprint-ops.ts";
import { OutboundError } from "../../../shared/outbound/failure.ts";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import type { GitRunner } from "../../change-areas/scripts/lib/resolve.ts";
import {
  carriedPath,
  normalizePaths,
  pathLines,
  type PredictionDeps,
  PredictionError,
  predictFootprint,
  seedAreas,
} from "../scripts/lib/footprint-writer.ts";
import { main, type WriteDeps } from "../scripts/write-footprint.ts";
import type { FootprintRecord } from "../../../shared/footprint.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "write-footprint.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "write-footprint-"));
  dirs.push(dir);
  return dir;
}

const CATALOG = parseCatalog({
  areas: {
    api: { paths: ["src/api/**"] },
    docs: { paths: ["docs/**"] },
    web: { paths: ["src/web/**"] },
  },
});

/** A git that answers `rev-parse` with `SHA` and `ls-files` from `tree`. */
function fakeGit(tree: Record<string, string[]> = {}): GitRunner {
  return (args) => {
    if (args[0] === "rev-parse") return `${SHA}\n`;
    if (args[0] === "ls-files")
      return (tree[args.at(-1) ?? ""] ?? []).join("\0");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}
function deps(over: Partial<PredictionDeps> = {}): PredictionDeps {
  return {
    git: fakeGit(),
    catalog: () => CATALOG,
    session: () => "session-1",
    root: scratch(),
    ...over,
  };
}

describe("predictFootprint", () => {
  test("a pickup records its paths, their seed areas, the base commit and its session", () => {
    const p = predictFootprint(
      {
        key: "#7",
        source: "pickup",
        baseRef: "origin/main",
        paths: {
          list: "src/web/b.ts\n./src/api/a.ts\n# a comment\n\nsrc/api/a.ts\n",
        },
      },
      deps(),
    );
    expect(p).toEqual({
      key: "#7",
      source: "pickup",
      base: SHA,
      paths: ["src/api/a.ts", "src/web/b.ts"],
      areas: ["api", "web"],
      pickup: "session-1",
    });
  });

  test("a scout or a filing names no session, and a pickup without one names none", () => {
    for (const source of ["scout", "filing"] as const)
      expect(
        predictFootprint(
          {
            key: "#7",
            source,
            baseRef: "origin/main",
            paths: { list: "docs/x.md" },
          },
          deps(),
        ).pickup,
      ).toBeUndefined();
    expect(
      predictFootprint(
        {
          key: "#7",
          source: "pickup",
          baseRef: "origin/main",
          paths: { list: "docs/x.md" },
        },
        deps({ session: () => "unknown" }),
      ).pickup,
    ).toBeUndefined();
  });

  test("no path named writes nothing", () => {
    const run = () =>
      predictFootprint(
        {
          key: "#7",
          source: "filing",
          baseRef: "origin/main",
          paths: { list: "# only a comment\n\n" },
        },
        deps(),
      );
    expect(run).toThrow(PredictionError);
    try {
      run();
    } catch (error) {
      expect((error as PredictionError).code).toBe("nothing");
    }
  });

  test("a base that names no commit is refused before any path is read", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "rev-parse") throw new Error("fatal: bad revision");
      throw new Error("read a path after the base failed");
    };
    expect(() =>
      predictFootprint(
        {
          key: "#7",
          source: "scout",
          baseRef: "origin/gone",
          paths: { list: "src/api/a.ts" },
        },
        deps({ git }),
      ),
    ).toThrow(
      /names no commit here, or git could not read it .*fatal: bad revision/,
    );
    expect(() =>
      predictFootprint(
        {
          key: "#7",
          source: "scout",
          baseRef: "--all",
          paths: { list: "src/api/a.ts" },
        },
        deps({ git }),
      ),
    ).toThrow(/not a base ref/);
  });
});

describe("normalizePaths", () => {
  test("a directory in the working tree ends in a slash; a new file stays a file", () => {
    const root = scratch();
    mkdirSync(join(root, "src", "api"), { recursive: true });
    expect(normalizePaths(["src/api", "src/api/new.ts", "src/"], root)).toEqual(
      ["src/", "src/api/", "src/api/new.ts"],
    );
  });

  test("traversal, absolute paths and globs are refused, naming the path", () => {
    for (const bad of ["../escape", "/etc/passwd", "src/**", "a//b"])
      expect(() => normalizePaths([bad], scratch())).toThrow(
        JSON.stringify(bad),
      );
  });

  test.skipIf(
    skipsOnWindows("file-system", "Windows refuses a directory path this long"),
  )("a directory too long to carry with its slash is refused", () => {
    const root = scratch();
    const name = "d".repeat(200);
    const long = [name, name, name, name, "e".repeat(216)].join("/");
    expect(long).toHaveLength(1020);
    mkdirSync(join(root, long), { recursive: true });
    const full = `${long}/abc`;
    mkdirSync(join(root, full));
    expect(full).toHaveLength(1024);
    expect(() => normalizePaths([full], root)).toThrow(/at most 1,024/);
  });

  test("more paths than a record carries are refused", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `f${i}.ts`);
    expect(() => normalizePaths(many, scratch())).toThrow(
      /name their directories/,
    );
  });

  test("a path through a file is refused as input, naming the path", () => {
    const root = scratch();
    writeFileSync(join(root, "file.ts"), "x\n");
    expect(() => normalizePaths(["file.ts/inner.ts"], root)).toThrow(
      /not a path in the working tree: "file.ts\/inner.ts"/,
    );
  });

  test("a changed file a footprint cannot name stands as its nearest parent it can", () => {
    expect(carriedPath("app/[id]/page.tsx")).toBe("app/");
    expect(carriedPath("src/a:b.ts")).toBe("src/");
    expect(carriedPath("src/ok.ts")).toBe("src/ok.ts");
    expect(carriedPath("[top].ts")).toBeNull();
  });

  test("a directory written with its slash is checked through its existing components", () => {
    const root = scratch();
    writeFileSync(join(root, "file.ts"), "x\n");
    expect(() => normalizePaths(["file.ts/"], root)).toThrow(
      /not a directory in the working tree: "file.ts"/,
    );
    expect(() => normalizePaths(["file.ts/inner/"], root)).toThrow(
      /not a directory in the working tree: "file.ts"/,
    );
    expect(normalizePaths(["missing/new/"], root)).toEqual(["missing/new/"]);
  });

  test("a path line with whitespace at an end is refused, not trimmed", () => {
    expect(() => pathLines("src/file.ts \n")).toThrow(/ambiguous/);
    expect(() => pathLines(" src/file.ts\n")).toThrow(/ambiguous/);
  });

  test("path lines drop blanks, comments and a leading ./", () => {
    expect(pathLines("a\r\n./b\n  # c\n\n./././d/\n")).toEqual([
      "a",
      "b",
      "d/",
    ]);
  });
});

describe("seedAreas", () => {
  test("a directory reaches the areas of its tracked files, in catalog order", () => {
    const git = fakeGit({ "src/": ["src/web/x.ts", "src/api/y.ts"] });
    expect(seedAreas(["src/", "docs/a.md"], CATALOG, git)).toEqual([
      "api",
      "docs",
      "web",
    ]);
  });

  test("a directory with no tracked file yet reaches the areas whose globs match it", () => {
    expect(seedAreas(["src/api/new/"], CATALOG, fakeGit())).toEqual(["api"]);
  });

  test("without a catalog there are no areas", () => {
    expect(seedAreas(["src/api/a.ts"], null, fakeGit())).toEqual([]);
  });
});

describe("main", () => {
  function harness(over: Partial<WriteDeps> = {}) {
    const written: FootprintRecord[] = [];
    const opened: string[] = [];
    const d: WriteDeps = {
      tracker: () => {
        opened.push("tracker");
        return {
          async writeFootprint(record) {
            written.push(record);
          },
        };
      },
      readPaths: async () => "src/api/a.ts\n",
      defaultBase: async () => "origin/main",
      predict: (options, pd) =>
        predictFootprint(options, {
          ...pd,
          git: fakeGit(),
          catalog: () => CATALOG,
        }),
      root: scratch,
      ...over,
    };
    return { d, written, opened };
  }

  test("writes the prediction with a writer and time the script supplies", async () => {
    const h = harness();
    expect(
      await main(["#7", "--source", "scout", "--paths", "p.txt"], h.d),
    ).toBe(0);
    expect(h.written).toHaveLength(1);
    const record = h.written[0] as FootprintRecord;
    expect(record).toMatchObject({
      key: "#7",
      source: "scout",
      base: SHA,
      paths: ["src/api/a.ts"],
      areas: ["api"],
    });
    expect(record.writer.host).toStartWith("sha256:");
    expect(record.at).toMatch(/Z$/);
  });

  test("a dry run prints and never opens the tracker", async () => {
    const h = harness();
    expect(
      await main(
        ["#7", "--source", "filing", "--paths", "p.txt", "--dry-run"],
        h.d,
      ),
    ).toBe(0);
    expect(h.opened).toEqual([]);
  });

  test("no path exits 3 and an unusable path exits 2, neither opening the tracker", async () => {
    const empty = harness({ readPaths: async () => "\n" });
    expect(
      await main(["#7", "--source", "filing", "--paths", "p.txt"], empty.d),
    ).toBe(3);
    const bad = harness({ readPaths: async () => "../x\n" });
    expect(
      await main(["#7", "--source", "filing", "--paths", "p.txt"], bad.d),
    ).toBe(2);
    expect([...empty.opened, ...bad.opened]).toEqual([]);
  });

  test("a usage error exits 2 before anything is read", async () => {
    const h = harness({
      readPaths: async () => {
        throw new Error("read the paths on a usage error");
      },
    });
    for (const argv of [
      ["#7", "--paths", "p.txt"],
      ["#7", "--source", "planner", "--paths", "p.txt"],
      ["#7", "--source", "scout"],
      ["#7", "--source", "scout", "--paths", "p.txt", "--diff"],
      ["not a key", "--source", "scout", "--paths", "p.txt"],
    ])
      expect(await main(argv, h.d)).toBe(2);
    expect(h.opened).toEqual([]);
  });

  test("a failed tracker write exits with its failure class", async () => {
    const h = harness({
      tracker: () => ({
        async writeFootprint() {
          throw new OutboundError("unauthorized", "token refused");
        },
      }),
    });
    expect(
      await main(["#7", "--source", "pickup", "--paths", "p.txt"], h.d),
    ).toBe(9);
  });

  test("an unknown base branch exits 2 and writes nothing", async () => {
    const h = harness({
      defaultBase: async () => {
        throw new PredictionError("input", "the base branch is unknown");
      },
    });
    expect(
      await main(["#7", "--source", "pickup", "--paths", "p.txt"], h.d),
    ).toBe(2);
    expect(h.opened).toEqual([]);
  });
});

describe("the command in a repository", () => {
  function git(cwd: string, ...args: string[]) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    expectSpawnExit(
      { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
      0,
      `git ${args.join(" ")}`,
    );
    return r.stdout;
  }
  function repository(): string {
    const dir = scratch();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    mkdirSync(join(dir, ".config"));
    mkdirSync(join(dir, "src", "api"), { recursive: true });
    writeFileSync(
      join(dir, ".config", "jig.yaml"),
      "drive:\n  change_areas_catalog: areas.yaml\n",
    );
    writeFileSync(
      join(dir, "areas.yaml"),
      "areas:\n  api:\n    paths: ['src/api/**']\n  docs:\n    paths: ['docs/**']\n",
    );
    writeFileSync(join(dir, "src", "api", "a.ts"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    return dir;
  }
  function run(dir: string, ...args: string[]) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (
        v !== undefined &&
        !k.startsWith("JIG_") &&
        !k.startsWith("CLAUDE_CODE_SESSION") &&
        !k.startsWith("CODEX_")
      )
        env[k] = v;
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...env,
        JIG_CONSUMER_ROOT: dir,
        CLAUDE_CODE_SESSION_ID: "session-9",
      },
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test("a filing from the workspace's diff records its changed files and their areas", () => {
    const dir = repository();
    writeFileSync(join(dir, "src", "api", "a.ts"), "changed\n");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "new.md"), "new\n");
    const r = run(
      dir,
      "#12",
      "--source",
      "filing",
      "--diff",
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 0);
    const head = git(dir, "rev-parse", "HEAD").trim();
    expect(JSON.parse(r.stdout)).toEqual({
      key: "#12",
      source: "filing",
      base: head,
      paths: ["docs/new.md", "src/api/a.ts"],
      areas: ["api", "docs"],
    });
  });

  test("a changed file with a glob character in its name is recorded as its directory", () => {
    const dir = repository();
    mkdirSync(join(dir, "src", "api", "[id]"));
    writeFileSync(join(dir, "src", "api", "[id]", "page.ts"), "new\n");
    const r = run(
      dir,
      "#12",
      "--source",
      "filing",
      "--diff",
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      paths: ["src/api/"],
      areas: ["api"],
    });
  });

  test("a changed top-level file a footprint cannot name is refused, not dropped", () => {
    const dir = repository();
    writeFileSync(join(dir, "[top].ts"), "new\n");
    writeFileSync(join(dir, "src", "api", "a.ts"), "changed\n");
    const r = run(
      dir,
      "#12",
      "--source",
      "filing",
      "--diff",
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("[top].ts");
  });

  test("a new untracked file behind a glob-named directory still reaches its area", () => {
    const dir = repository();
    writeFileSync(
      join(dir, "areas.yaml"),
      "areas:\n  pages:\n    paths: ['src/**/*.ts']\n",
    );
    mkdirSync(join(dir, "src", "[id]"));
    writeFileSync(join(dir, "src", "[id]", "page.ts"), "new\n");
    const r = run(
      dir,
      "#12",
      "--source",
      "filing",
      "--diff",
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 0);
    const payload = JSON.parse(r.stdout);
    expect(payload.paths).toContain("src/");
    expect(payload.areas).toEqual(["pages"]);
  });

  test("a dry run refuses a payload a write would refuse", () => {
    const dir = repository();
    writeFileSync(
      join(dir, "areas.yaml"),
      "areas:\n  api.v2:\n    paths: ['src/api/**']\n",
    );
    writeFileSync(join(dir, "paths.txt"), "src/api/a.ts\n");
    const r = run(
      dir,
      "#12",
      "--source",
      "filing",
      "--paths",
      join(dir, "paths.txt"),
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("invalid prediction payload");
  });

  test("a paths file that is not a regular file is refused without blocking", () => {
    const dir = repository();
    const r = run(
      dir,
      "#12",
      "--source",
      "scout",
      "--paths",
      dir,
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("paths file cannot be read");
  });

  test("a clean workspace has no diff to record and exits 3", () => {
    const dir = repository();
    const r = run(
      dir,
      "#12",
      "--source",
      "filing",
      "--diff",
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("no change against origin/main");
  });

  test("a pickup's printed payload is a record the codec reads back, naming its session", () => {
    const dir = repository();
    writeFileSync(join(dir, "paths.txt"), "src/api\n");
    const r = run(
      dir,
      "ENG-4",
      "--source",
      "pickup",
      "--paths",
      "paths.txt",
      "--base",
      "origin/main",
      "--dry-run",
    );
    expectSpawnExit(r, 0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toMatchObject({
      paths: ["src/api/"],
      areas: ["api"],
      pickup: "session-9",
    });
    const body = footprintBody(predictionRecord("ENG-4", payload));
    expect(readFootprint(body, "ENG-4")).toMatchObject({
      source: "pickup",
      paths: ["src/api/"],
      pickup: "session-9",
    });
  });
});

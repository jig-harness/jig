import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLimitMs } from "../herdr/limits.ts";
import type { OpenRequest } from "./provider.ts";
import { openRequest } from "./test-request.ts";
import {
  branchFor,
  herdrProvider,
  loginShellPath,
  parseRepo,
  slugOf,
} from "./providers/herdr.ts";

const cacheFile = join(
  mkdtempSync(join(tmpdir(), "herdr-cache-")),
  "ENG-1.json",
);
writeFileSync(cacheFile, "{}");

const request = (repo: unknown, branch = ""): OpenRequest =>
  openRequest(repo, "/jig:do-item ENG-1", { branch, cacheFile });

describe("settings", () => {
  test("a path alone, or a mapping", () => {
    expect(parseRepo("~/dev/app", "app")).toEqual({ path: "~/dev/app" });
    expect(
      parseRepo(
        {
          path: "/srv/app",
          host: "builder",
          agent: "codex",
          base: "origin/dev",
        },
        "app",
      ),
    ).toEqual({
      path: "/srv/app",
      host: "builder",
      agent: "codex",
      base: "origin/dev",
    });
  });
  test("an unknown key, a missing path or an option-like host is refused", () => {
    expect(() => parseRepo({ path: "/a", hots: "x" }, "app")).toThrow(
      "unknown key hots",
    );
    expect(() => parseRepo({ host: "x" }, "app")).toThrow(
      "repos.app.herdr.path is required",
    );
    expect(() =>
      parseRepo({ path: "/a", host: "-oProxyCommand=x" }, "app"),
    ).toThrow("not an SSH destination");
    expect(() => herdrProvider().validateRepo(7, "app")).toThrow(
      "repos.app.herdr",
    );
  });
});

describe("the branch", () => {
  const issue = (branch: string, title = "") => ({
    issue: "ENG-1",
    branch,
    title,
  });

  test("is the tracker's suggestion, else the issue key", () => {
    expect(branchFor({}, issue("me/eng-1-fix"))).toEqual({
      branch: "me/eng-1-fix",
    });
    expect(branchFor({}, issue(""))).toEqual({ branch: "eng-1" });
  });

  test("follows the repository's name for it, with the part before {slug} to reuse", () => {
    const repo = { branch: "feature/{key}-{slug}" };
    expect(
      branchFor(repo, issue("me/eng-1", "Fix the  Login: page, twice!")),
    ).toEqual({
      branch: "feature/ENG-1-fix-the-login-page",
      reusePrefix: "feature/ENG-1-",
    });
    expect(branchFor({ branch: "work/{key}" }, issue("me/eng-1"))).toEqual({
      branch: "work/ENG-1",
    });
    expect(() => branchFor(repo, issue("", "  ·  "))).toThrow(
      "no title to name its branch by",
    );
  });

  test("a title in any script keeps its letters", () => {
    expect(slugOf("修复 登录页面")).toBe("修复-登录页面");
    expect(slugOf("Réparer la page de connexion")).toBe("réparer-la-page-de");
    expect(slugOf("ठीक करें लॉगिन पेज")).toBe("ठीक-करें-लॉगिन-पेज");
    expect(slugOf("Re\u0301parer la page de connexion")).toBe(
      "réparer-la-page-de",
    );
  });

  test("is not named by the repository's pattern for a key another issue's could continue", () => {
    const repo = { branch: "feature/{key}-{slug}" };
    const titled = (key: string) => ({ issue: key, branch: "", title: "Fix" });
    expect(branchFor(repo, titled("ENG_X-7")).reusePrefix).toBe(
      "feature/ENG_X-7-",
    );
    for (const key of ["ENG-1-2", "ENG", "ENG-1a", "12"])
      expect(() => branchFor(repo, titled(key))).toThrow(
        "not a key of the form TEAM-123",
      );
    expect(branchFor({ branch: "work/{key}" }, titled("ENG-1-2"))).toEqual({
      branch: "work/ENG-1-2",
    });
  });

  test("a name that cannot tell one issue's branches from another's is refused", () => {
    const named = (branch: string) => parseRepo({ path: "/a", branch }, "app");
    expect(named("feature/{key}-{slug}").branch).toBe("feature/{key}-{slug}");
    expect(() => named("feature/{slug}")).toThrow("{key} once");
    expect(() => named("{key}-{key}")).toThrow("{key} once");
    expect(() => named("{key}{slug}")).toThrow("text between them");
    expect(() => named("{slug}-{key}")).toThrow("after {key}");
    expect(() => named("feature/{key}2{slug}")).toThrow(
      "must not open with a letter or digit",
    );
    expect(() => named("feature/{key}x-{slug}")).toThrow(
      "must not open with a letter or digit",
    );
    expect(() => named("{key}-{title}")).toThrow("unknown placeholder {title}");
  });

  test("is passed to the tool with its reuse prefix", async () => {
    const seen: string[][] = [];
    const provider = herdrProvider({
      runTool: async (_host, args) => {
        seen.push(args);
        return { status: 0, stderr: "" };
      },
    });
    await provider.open({
      ...request({ path: "/srv/app", branch: "feature/{key}-{slug}" }),
      title: "Fix login",
    });
    const args = seen[0] ?? [];
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--branch")).toBe("feature/ENG-1-fix-login");
    expect(after("--reuse-prefix")).toBe("feature/ENG-1-");
  });
});

describe("open", () => {
  test("on a host: the cache is copied first and the prompt names the copy", async () => {
    const calls: { host: string | undefined; args: string[] }[] = [];
    const provider = herdrProvider({
      copyCache: async (host, file) =>
        `/home/agent/.cache/x/${host}-${file.endsWith("ENG-1.json")}`,
      runTool: async (host, args) => {
        calls.push({ host, args });
        return { status: 0, stderr: "" };
      },
    });
    await provider.open(
      request({ path: "~/dev/app", host: "builder" }, "me/eng-1"),
    );
    expect(calls).toEqual([
      {
        host: "builder",
        args: [
          "open",
          "--repo",
          "~/dev/app",
          "--branch",
          "me/eng-1",
          "--label",
          "ENG-1",
          "--agent",
          "claude",
          "--prompt",
          "/jig:do-item ENG-1\nLauncher context: /home/agent/.cache/x/builder-true",
          "--key",
          "ENG-1",
        ],
      },
    ]);
  });

  test("on this machine: the prompt names the local cache file", async () => {
    const seen: string[][] = [];
    const provider = herdrProvider({
      copyCache: async () => {
        throw new Error("no copy on this machine");
      },
      runTool: async (_host, args) => {
        seen.push(args);
        return { status: 0, stderr: "" };
      },
    });
    await provider.open(request({ path: "/srv/app", base: "origin/dev" }));
    expect(seen[0]).toContain(
      `/jig:do-item ENG-1\nLauncher context: ${cacheFile}`,
    );
    expect(seen[0]).toEqual(expect.arrayContaining(["--base", "origin/dev"]));
  });

  test("on a host, a cache file that was not written is refused before anything runs", async () => {
    let ran = false;
    const provider = herdrProvider({
      copyCache: async () => {
        ran = true;
        return "/nowhere";
      },
      runTool: async () => {
        ran = true;
        return { status: 0, stderr: "" };
      },
    });
    const missing = {
      ...request({ path: "~/dev/app", host: "builder" }),
      cacheFile: join(tmpdir(), "no-such-dir-herdr", "ENG-1.json"),
    };
    await expect(provider.open(missing)).rejects.toThrow("was not written");
    // An earlier launch's file is on disk, but this launch's write failed.
    const stale = {
      ...request({ path: "~/dev/app", host: "builder" }),
      cacheWriteFailed: true,
    };
    await expect(provider.open(stale)).rejects.toThrow("nothing current");
    expect(ran).toBe(false);
  });

  test("an issue with no repository is refused, and a failed tool run is an error", async () => {
    const provider = herdrProvider({
      runTool: async () => ({ status: 1, stderr: "ERROR: x" }),
    });
    await expect(provider.open(request(null))).rejects.toThrow(
      "not routed to a repository",
    );
    await expect(provider.open(request("/srv/app"))).rejects.toThrow(
      "workspace tool failed (exit 1)",
    );
  });

  test("the local tool gets the login shell's PATH, else the inherited one", () => {
    const answer = (exitCode: number, stdout: string) =>
      (() => ({
        exitCode,
        stdout: Buffer.from(stdout),
      })) as unknown as typeof Bun.spawnSync;
    const env = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    expect(loginShellPath(env, answer(0, "/opt/homebrew/bin:/usr/bin"))).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
    // A profile's banner comes first; the PATH is the last line.
    expect(
      loginShellPath(
        env,
        answer(0, "Welcome\nnvm: using 22\n/opt/bin:/usr/bin"),
      ),
    ).toBe("/opt/bin:/usr/bin");
    expect(loginShellPath(env, answer(1, ""))).toBe("/usr/bin");
    expect(loginShellPath({ PATH: "/usr/bin" }, answer(0, "/x"))).toBe(
      "/usr/bin",
    );
  });

  test("the provider's budget covers every open the tool allows", () => {
    expect(herdrProvider().openBudgetMs).toBeGreaterThan(openLimitMs());
  });
});

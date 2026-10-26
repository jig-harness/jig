import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opened, OpenOptions } from "../orca/workspace.ts";
import type { OpenRequest } from "./provider.ts";
import { getProvider, providerNames } from "./providers/index.ts";
import {
  type OrcaRepo,
  openOptions,
  orcaProvider,
  parseOpened,
  parseRepo,
} from "./providers/orca.ts";
import { openRequest } from "./test-request.ts";

const cacheFile = join(
  mkdtempSync(join(tmpdir(), "orca-cache-")),
  "ENG-1.json",
);
writeFileSync(cacheFile, "{}");

const request = (repo: unknown, branch = ""): OpenRequest =>
  openRequest(repo, "/jig:do-item ENG-1", { branch, cacheFile });

const opened = (options: OpenOptions): Opened => ({
  path: "/ws/app/x",
  branch: options.branch,
  worktreeId: "rid::/ws/app/x",
  reattached: false,
  hookRan: false,
  agentLaunched: true,
  kickoff: "sent",
});

describe("settings", () => {
  test("a name alone, or a mapping", () => {
    expect(parseRepo("app", "app")).toEqual({ repo: "app" });
    expect(
      parseRepo(
        {
          repo: "app",
          environment: "box",
          ssh: "box.example",
          agent: "codex",
          base: "origin/dev",
          branch: "feature/{key}-{slug}",
          slug: "ascii",
        },
        "app",
      ),
    ).toEqual({
      repo: "app",
      environment: "box",
      ssh: "box.example",
      agent: "codex",
      base: "origin/dev",
      branch: "feature/{key}-{slug}",
      slug: "ascii",
    });
  });

  test("a server's host is its name unless ssh says otherwise, and ssh alone is refused", () => {
    expect(parseRepo({ repo: "app", environment: "box" }, "app")).toEqual({
      repo: "app",
      environment: "box",
      ssh: "box",
    });
    expect(() => parseRepo({ repo: "app", ssh: "box" }, "app")).toThrow(
      "needs repos.app.orca.environment",
    );
    expect(() =>
      parseRepo({ repo: "app", environment: "my box" }, "app"),
    ).toThrow("repos.app.orca.environment:");
    expect(() =>
      parseRepo(
        { repo: "app", environment: "box", ssh: "-oProxyCommand=x" },
        "app",
      ),
    ).toThrow("repos.app.orca.ssh:");
  });

  test("an unknown key, a missing name or a bad branch template is refused", () => {
    expect(() => parseRepo({ repo: "app", hots: "x" }, "app")).toThrow(
      "unknown key hots",
    );
    expect(() => parseRepo({ environment: "box" }, "app")).toThrow(
      "repos.app.orca.repo is required",
    );
    expect(() => parseRepo({ repo: "app", branch: "{slug}" }, "app")).toThrow(
      "{key} once",
    );
    expect(() => parseRepo({ repo: "app", slug: "latin" }, "app")).toThrow(
      "known: any, ascii",
    );
    expect(() => orcaProvider().validateRepo(7, "app")).toThrow(
      "repos.app.orca",
    );
  });
});

describe("clone", () => {
  test("fills {repo} in the URL and is handed to the tool", () => {
    const repo = parseRepo(
      {
        repo: "docket",
        clone: { url: "git@example.com:acme/{repo}.git", root: "~/dev" },
      },
      "docket",
    );
    expect(repo.clone).toEqual({
      url: "git@example.com:acme/docket.git",
      root: "~/dev",
    });
    expect(openOptions(repo, request(null), "p").clone).toEqual(repo.clone);
  });

  test("needs a URL and a root that names a place on its own", () => {
    for (const [clone, message] of [
      ["x", "repos.app.orca.clone must be a mapping of url and root"],
      [{ url: "u" }, "repos.app.orca.clone needs both url and root"],
      [{ url: "u", root: "dev" }, "root must be absolute or start with ~/"],
      [{ url: "u", root: "/d", depth: 1 }, "unknown key depth"],
    ] as const)
      expect(() => parseRepo({ repo: "app", clone }, "app")).toThrow(message);
  });

  test("refuses, when the configuration is checked, a source the clone would refuse", () => {
    for (const url of ["x", "{repo}", "--upload-pack=touch /tmp/x"])
      expect(() =>
        orcaProvider().validateRepo(
          { repo: "app", clone: { url, root: "/srv/repos" } },
          "app",
        ),
      ).toThrow("repos.app.orca.clone.url: the clone source");
    expect(
      parseRepo(
        { repo: "app", clone: { url: "/srv/Source Repos/{repo}", root: "~" } },
        "app",
      ).clone?.url,
    ).toBe("/srv/Source Repos/app");
    expect(
      parseRepo(
        {
          repo: "app",
          clone: { url: "git@example.com:/srv/git/{repo}.git", root: "~" },
        },
        "app",
      ).clone?.url,
    ).toBe("git@example.com:/srv/git/app.git");
  });
});

describe("open", () => {
  test("is registered under its name", () => {
    expect(providerNames()).toContain("orca");
    expect(getProvider("orca").name).toBe("orca");
  });

  test("refuses an issue that is not routed", async () => {
    await expect(orcaProvider().open(request(null))).rejects.toThrow(
      "not routed to a repository",
    );
  });

  test("passes the branch, the prompt, the key, the issue and the launch's deadline to the tool", async () => {
    const seen: Array<{
      repo: OrcaRepo;
      options: OpenOptions;
      signal: AbortSignal;
    }> = [];
    const provider = orcaProvider({
      open: async (repo, options, signal) => {
        seen.push({ repo, options, signal });
        return opened(options);
      },
    });
    const asked = {
      ...request({ repo: "app", branch: "feature/{key}-{slug}" }),
      title: "Fix login",
    };
    await provider.open(asked);
    expect(seen[0]?.signal).toBe(asked.signal);
    expect(seen[0]?.options).toEqual({
      repo: "app",
      branch: "feature/ENG-1-fix-login",
      reusePrefix: "feature/ENG-1-",
      agent: "claude",
      noAgent: false,
      prompt: `/jig:do-item ENG-1\nLauncher context: ${cacheFile}`,
      key: "ENG-1",
      comment: "ENG-1: Fix login",
      linearIssue: "ENG-1",
      activate: true,
    });
  });

  test("names the branch the tracker suggests, else the key, and a base when the repository has one", () => {
    const base = openOptions(
      { repo: "app", base: "origin/dev", agent: "codex" },
      request("app", "me/eng-1-fix"),
      "p",
    );
    expect(base).toMatchObject({
      branch: "me/eng-1-fix",
      base: "origin/dev",
      agent: "codex",
      comment: "ENG-1",
    });
    expect(base.reusePrefix).toBeUndefined();
    expect(openOptions({ repo: "app" }, request("app"), "p").branch).toBe(
      "eng-1",
    );
  });

  test("on a server, copies the cache to its host and names the copy in the prompt", async () => {
    const copies: string[] = [];
    const prompts: string[] = [];
    const provider = orcaProvider({
      copyCache: async (host, file) => {
        copies.push(`${host}:${file}`);
        return "/home/u/.cache/conductor-linear/ENG-1.json";
      },
      open: async (_repo, options) => {
        prompts.push(options.prompt ?? "");
        return opened(options);
      },
    });
    await provider.open(request({ repo: "app", environment: "box" }));
    expect(copies).toEqual([`box:${cacheFile}`]);
    expect(prompts[0]).toBe(
      "/jig:do-item ENG-1\nLauncher context: /home/u/.cache/conductor-linear/ENG-1.json",
    );
  });

  test("on this machine, copies nothing and keeps the prompt", async () => {
    const prompts: string[] = [];
    const provider = orcaProvider({
      copyCache: async () => {
        throw new Error("must not copy");
      },
      open: async (_repo, options) => {
        prompts.push(options.prompt ?? "");
        return opened(options);
      },
    });
    await provider.open(request("app"));
    expect(prompts[0]).toBe(
      `/jig:do-item ENG-1\nLauncher context: ${cacheFile}`,
    );
  });

  test("on a server, refuses when this launch did not write the cache", async () => {
    const provider = orcaProvider({
      copyCache: async () => "/elsewhere",
      open: async () => {
        throw new Error("must not open");
      },
    });
    await expect(
      provider.open({
        ...request({ repo: "app", environment: "box" }),
        cacheWriteFailed: true,
      }),
    ).rejects.toThrow("was not written by this launch");
    await expect(
      provider.open({
        ...request({ repo: "app", environment: "box" }),
        cacheFile: join(tmpdir(), "no-such-cache-file.json"),
      }),
    ).rejects.toThrow("was not written by this launch");
  });
});

describe("the tool's answer", () => {
  test("is what it opened, and anything else is an error", () => {
    const answer = opened({
      ...openOptions({ repo: "app" }, request("app"), "p"),
    });
    expect(parseOpened(`${JSON.stringify(answer)}\n`)).toEqual(answer);
    for (const text of [
      "",
      "not json",
      '{"path":"/ws/app/x"}',
      JSON.stringify({ ...answer, kickoff: "maybe" }),
      // An array of one allowed word reads as that word once coerced.
      JSON.stringify({ ...answer, kickoff: ["already-sent"] }),
      JSON.stringify({ ...answer, reattached: "no" }),
    ])
      expect(() => parseOpened(text)).toThrow(
        "answered with something other than what it opened",
      );
  });
});

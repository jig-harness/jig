import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { launch } from "./launch.ts";
import { cachePath } from "./cache.ts";
import { githubTracker } from "./trackers/github.ts";
import type { OpenRequest, Provider } from "./provider.ts";

test("GitHub number, key and URL open the same workspace and cache", async () => {
  const home = mkdtempSync(join(tmpdir(), "launcher-github-"));
  try {
    mkdirSync(join(home, ".linear"));
    writeFileSync(
      join(home, ".linear", "launcher.yaml"),
      "tracker: github\nprovider: fake\nrepos:\n  service:\n    github: {repository: acme/service}\n    fake: service\n",
    );
    const opened: OpenRequest[] = [];
    const provider: Provider = {
      name: "fake",
      validateRepo() {
        /* This fake accepts any settings. */
      },
      async open(request) {
        opened.push(request);
      },
    };
    const tracker = githubTracker(
      {
        home,
        env: {},
        repos: { service: { github: { repository: "acme/service" } } },
      },
      {
        async run(args) {
          if (args[0] === "user") return { login: "opener" };
          if (args.includes("POST"))
            return { assignees: [{ login: "opener" }] };
          if (args[0]?.endsWith("/comments"))
            return [
              [
                {
                  body: "context",
                  user: { id: 1 },
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
            ];
          return {
            number: 123,
            title: "Fix login",
            body: "Details",
            labels: [],
            assignees: [],
          };
        },
      },
    );
    for (const input of [
      "#123",
      "123",
      "https://github.com/acme/service/issues/123",
    ])
      await launch(input, undefined, {
        home,
        env: {},
        tracker,
        provider,
        nowSeconds: () => 100,
      });
    expect(opened).toHaveLength(3);
    expect(
      opened.map(({ issue, title, repo, branch, prompt }) => ({
        issue,
        title,
        repo,
        branch,
        prompt,
      })),
    ).toEqual(
      Array(3).fill({
        issue: "#123",
        title: "Fix login",
        repo: "service",
        branch: "",
        prompt: `/jig:do-item #123\n#123 — Fix login\nLauncher context: ${cachePath(home, "#123", "github/acme/service")}`,
      }),
    );
    expect(cachePath(home, "#123", "github/acme/service")).toEndWith(
      "/issue-123.json",
    );
    expect(existsSync(cachePath(home, "#123", "github/acme/service"))).toBe(
      true,
    );
    expect(cachePath(home, "ENG-123")).toEndWith("/ENG-123.json");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GitHub settings refuse unknown keys and ambiguous bare numbers", () => {
  expect(() =>
    githubTracker({
      home: "/tmp",
      env: {},
      repos: {
        service: { github: { repository: "acme/service", typo: true } },
      },
    }),
  ).toThrow("typo");
  const tracker = githubTracker({
    home: "/tmp",
    env: {},
    repos: {
      one: { github: { repository: "acme/one" } },
      two: { github: { repository: "acme/two" } },
    },
  });
  expect(() => tracker.normalizeIssue?.("123")).toThrow("web address");
  expect(() =>
    tracker.normalizeIssue?.("https://github.com/acme/other/issues/123"),
  ).toThrow("not configured");
});

test("GitHub refuses mismatched issues and omits incomplete comments", async () => {
  const options = {
    home: "/tmp",
    env: {},
    repos: { service: { github: { repository: "acme/service" } } },
  };
  const request = {
    issue: "#123",
    repoLabelGroup: "Repo",
    fallback: {},
    nowSeconds: 1,
    signal: AbortSignal.timeout(1000),
  };
  const mismatched = githubTracker(options, {
    async run() {
      return { number: 124, title: "wrong", body: "wrong" };
    },
  });
  expect(await mismatched.read(request)).toHaveProperty("cache", null);
  const partial = githubTracker(options, {
    async run(args) {
      if (args[0]?.endsWith("/comments"))
        return [
          [{ body: "early", created_at: "2026-01-01" }],
          [{ broken: true }],
        ];
      if (args[0] === "user") throw new Error("no credential");
      return { number: 123, title: "right", body: null };
    },
  });
  const result = await partial.read(request);
  expect("unavailable" in result).toBe(false);
  if ("unavailable" in result) return;
  expect(result.cache?.description).toBe("");
  expect(result.cache?.comments).toBeUndefined();
  expect(result.cache?.comments_cached).toBeUndefined();
  expect(await result.assignToOpener(request.signal)).toEqual({
    assigned: false,
    reason: "no credential",
  });
  const unavailable = githubTracker(options, {
    async run() {
      throw new Error("gh missing");
    },
  });
  expect(await unavailable.read(request)).toHaveProperty(
    "repoLabel",
    "service",
  );
});

const API = "https://api.github.com/repos";

async function readLinked(blockedBy: () => unknown, blocking: () => unknown) {
  const tracker = githubTracker(
    {
      home: "/tmp",
      env: {},
      repos: { service: { github: { repository: "acme/service" } } },
    },
    {
      async run(args) {
        if (args[0]?.endsWith("/comments")) return [[]];
        if (args[0]?.endsWith("/blocked_by")) return blockedBy();
        if (args[0]?.endsWith("/blocking")) return blocking();
        return { number: 123, title: "right", body: null, assignees: [] };
      },
    },
  );
  const result = await tracker.read({
    issue: "#123",
    repoLabelGroup: "Repo",
    fallback: {},
    nowSeconds: 1,
    signal: AbortSignal.timeout(1000),
  });
  expect("unavailable" in result).toBe(false);
  if ("unavailable" in result) throw new Error("unavailable");
  return result;
}

test("GitHub caches issue dependencies from both directions, qualifying foreign repositories", async () => {
  const result = await readLinked(
    () => [[{ number: 7, repository_url: `${API}/acme/service` }]],
    () => [
      [
        { number: 7, repository_url: `${API}/acme/other` },
        { number: 8, repository_url: `${API}/Acme/Service` },
      ],
    ],
  );
  expect(result.cache?.linked_issue_ids).toEqual(["#7", "acme/other#7", "#8"]);
});

test("GitHub keeps one dependency direction when the other fails", async () => {
  const result = await readLinked(
    () => [[{ number: 7, repository_url: `${API}/acme/service` }]],
    () => {
      throw new Error("boom");
    },
  );
  expect(result.cache?.linked_issue_ids).toEqual(["#7"]);
  expect(result.warnings.join("\n")).toContain("dependencies/blocking");
});

test("GitHub skips a malformed dependency and keeps its valid siblings", async () => {
  const result = await readLinked(
    () => [
      [{ number: 7 }, { number: 9, repository_url: `${API}/acme/service` }],
    ],
    () => [[]],
  );
  expect(result.cache?.linked_issue_ids).toEqual(["#9"]);
  expect(result.warnings.join("\n")).toContain("skipped");
});

test("equal issue numbers in different repositories keep separate caches", async () => {
  const home = mkdtempSync(join(tmpdir(), "launcher-github-repos-"));
  try {
    mkdirSync(join(home, ".linear"));
    writeFileSync(
      join(home, ".linear", "launcher.yaml"),
      "tracker: github\nprovider: fake\nrepos:\n  one:\n    github: {repository: acme/one}\n    fake: one\n  two:\n    github: {repository: acme/two}\n    fake: two\n",
    );
    const opened: OpenRequest[] = [];
    const provider: Provider = {
      name: "fake",
      validateRepo() {
        /* This fake accepts any settings. */
      },
      async open(request) {
        opened.push(request);
      },
    };
    let failTwo = true;
    const tracker = githubTracker(
      {
        home,
        env: {},
        repos: {
          one: { github: { repository: "acme/one" } },
          two: { github: { repository: "acme/two" } },
        },
      },
      {
        async run(args) {
          if (args[0] === "user") return { login: "opener" };
          if (args[0]?.endsWith("/comments")) return [[]];
          if (args[0]?.includes("acme/two") && failTwo)
            throw new Error("unreadable");
          return {
            number: 123,
            title: args[0]?.includes("acme/one") ? "One" : "Two",
            body: "context",
            assignees: [{ login: "opener" }],
          };
        },
      },
    );
    const deps = {
      home,
      env: {},
      tracker,
      provider,
      warn() {
        /* Expected failed-read warnings are recorded by the assertions. */
      },
    };
    await launch("https://github.com/acme/one/issues/123", undefined, deps);
    await launch("https://github.com/acme/two/issues/123", undefined, deps);
    expect(opened[0]?.cacheFile).not.toBe(opened[1]?.cacheFile);
    expect(opened[1]?.title).toBe("");
    expect(opened[1]?.repo).toBe("two");
    failTwo = false;
    await launch("https://github.com/acme/two/issues/123", undefined, deps);
    expect(opened[2]?.title).toBe("Two");
    expect(
      JSON.parse(
        await Bun.file(cachePath(home, "#123", "github/acme/one")).text(),
      ).title,
    ).toBe("One");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GitHub accepts repository punctuation without allowing path traversal", () => {
  for (const repository of ["acme/.github", "acme/_service", "acme/-service"]) {
    const tracker = githubTracker({
      home: "/tmp",
      env: {},
      repos: { service: { github: { repository } } },
    });
    expect(
      tracker.normalizeIssue?.(`https://github.com/${repository}/issues/123`),
    ).toBe("#123");
    expect(
      cachePath("/tmp", "#123", tracker.cacheNamespace?.("123")),
    ).toEndWith("issue-123.json");
  }
  for (const repository of ["acme/.", "acme/.."]) {
    expect(() =>
      githubTracker({
        home: "/tmp",
        env: {},
        repos: { service: { github: { repository } } },
      }),
    ).toThrow("repository");
  }
});

test("GitHub subprocess pins its hostname despite ambient GH_HOST", async () => {
  const home = mkdtempSync(join(tmpdir(), "launcher-github-gh-"));
  try {
    const log = join(home, "calls.jsonl");
    writeFakeProgram(
      join(home, "gh"),
      String.raw`#!/usr/bin/env bun
import {appendFileSync} from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\n");
const endpoint = args[3];
console.log(JSON.stringify(endpoint === "user" ? {login: "opener"} : endpoint.endsWith("/comments") ? [[]] : {number: 123, title: "Right host", body: "Context", assignees: [{login: "opener"}]}));
`,
    );
    const tracker = githubTracker({
      home,
      env: {
        ...process.env,
        PATH: home + delimiter + process.env.PATH,
        GH_HOST: "other.example",
        ARGV_LOG: log,
      },
      repos: { service: { github: { repository: "acme/service" } } },
    });
    const signal = AbortSignal.timeout(5000);
    const read = await tracker.read({
      issue: "#123",
      repoLabelGroup: "Repo",
      fallback: {},
      nowSeconds: 1,
      signal,
    });
    expect("unavailable" in read).toBe(false);
    if ("unavailable" in read) return;
    expect(read.cache?.title).toBe("Right host");
    expect(await read.assignToOpener(signal)).toEqual({ assigned: true });
    const calls = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(5);
    for (const args of calls)
      expect(args.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

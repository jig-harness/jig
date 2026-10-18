import { describe, expect, test } from "bun:test";
import {
  checkBase,
  defaultBranch,
  integrationBranch,
  remoteRef,
} from "../scripts/branches.ts";
import {
  github as githubAt,
  type Gh,
  hostingFor,
  type Hosting,
} from "../scripts/hosting.ts";
import { runStatus, status } from "../scripts/status.ts";
import {
  COMMON_CHANGELOG,
  git,
  KEEP_CHANGELOG,
  repository,
  resolvedFor,
  temporary,
  write,
} from "./scratch.ts";

const files = (): Record<string, string> => ({
  "CHANGELOG.md": KEEP_CHANGELOG,
  "package.json": `{"version": "1.2.0"}\n`,
  "changes/README.md": "x\n",
  "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- a\n",
  "changes/b.md": "### Fixed\n\n- b\n",
});
const stub = (state: Hosting["lastReleaseRun"]): Hosting => ({
  name: "stub",
  defaultBranch: () => "main",
  lastReleaseRun: state,
});

describe("status", () => {
  test("lists the notes that ask for a release, the version they make, and where the rest go", () => {
    const root = repository(files());
    const seen: string[] = [];
    const result = status(
      resolvedFor(root),
      stub((branch) => {
        seen.push(branch);
        return { state: "success", detail: "fine" };
      }),
      { JIG_HOME: temporary() },
    );
    expect(result).toMatchObject({
      configured: true,
      format: "keep-a-changelog",
      current: "1.2.0",
      next: "1.3.0",
      releasing: [{ file: "changes/a.md", release: "minor" }],
      waiting: [],
      unreleased: ["changes/b.md"],
      errors: [],
      releaseRun: { state: "success" },
    });
    expect(seen).toEqual(["main"]);
  });

  test("a note that waits for a release is listed as waiting, not as a failed release", () => {
    const root = repository({
      "CHANGELOG.md": COMMON_CHANGELOG,
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/b.md": "### Fixed\n\n- b\n",
    });
    const result = status(
      resolvedFor(root, { format: "common-changelog" }),
      null,
      { JIG_HOME: temporary() },
    );
    expect(result).toMatchObject({
      next: null,
      releasing: [],
      waiting: ["changes/b.md"],
      unreleased: [],
      releaseRun: { state: "unknown" },
    });
  });

  test("the integration branch is the repository's base_branch, else the hosting service's default", () => {
    const root = repository({
      ...files(),
      ".config/jig.yaml": "repository:\n  base_branch: develop\n",
    });
    const asked: string[] = [];
    status(
      resolvedFor(root),
      stub((branch) => {
        asked.push(branch);
        return { state: "none", detail: "" };
      }),
      { JIG_HOME: temporary() },
    );
    expect(asked).toEqual(["develop"]);
  });

  test("a note it cannot read is reported", () => {
    const root = repository(files());
    write(root, "changes/c.md", "### Improved\n\n- c\n");
    const result = status(resolvedFor(root), null, { JIG_HOME: temporary() });
    expect(result.errors.join("\n")).toContain("not a change type");
  });

  test("a failed last release run is exit 1; one that cannot be read is not", () => {
    const root = repository({
      ...files(),
      ".config/jig.yaml": "changelog:\n  file: CHANGELOG.md\n",
    });
    const env = { JIG_HOME: temporary() };
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      expect(
        runStatus(
          root,
          false,
          env,
          stub(() => ({ state: "failure", detail: "it failed" })),
        ),
      ).toBe(1);
      expect(
        runStatus(
          root,
          true,
          env,
          stub(() => ({ state: "unknown", detail: "no gh" })),
        ),
      ).toBe(0);
      expect(runStatus(root, false, env, null)).toBe(0);
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    expect(text).toContain("jig changelog status (plugin ");
    expect(text).toContain("release run on main: failure (it failed)");
    expect(text).toContain("next release: 1.3.0");
    expect(
      JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}"),
    ).toMatchObject({
      next: "1.3.0",
    });
  });

  test("a repository without the field is told so, as text and as JSON", () => {
    const root = repository({ "a.txt": "x" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      expect(runStatus(root, false, { JIG_HOME: temporary() }, null)).toBe(0);
      expect(runStatus(root, true, { JIG_HOME: temporary() }, null)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("not configured");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      configured: false,
    });
  });
});

describe("the last release run, through gh", () => {
  type Listed = Record<string, unknown>;
  /** The runs of one listing as GitHub answers it: by creation time and limit. */
  function listing(runs: Listed[], args: string[]): Listed[] {
    const created = args.includes("--created")
      ? args[args.indexOf("--created") + 1]
      : undefined;
    const [from, to] = created?.startsWith(">=")
      ? [created.slice(2), undefined]
      : (created?.split("..") ?? []);
    const time = (run: Listed) => String(run.createdAt ?? "");
    return runs
      .filter((run) => (!from || time(run) >= from) && (!to || time(run) <= to))
      .toSorted((x, y) => time(y).localeCompare(time(x)))
      .slice(0, Number(args[args.indexOf("--limit") + 1]));
  }
  /** gh answering the workflow list with `workflows` and each workflow's runs from `runs`. */
  const answering =
    (
      runs: Record<number, Listed[]> | string | null,
      workflows: Listed[] = [{ id: 1, name: "release" }],
      seen: string[][] = [],
    ): Gh =>
    (args) => {
      seen.push(args);
      if (args[0] === "workflow") return JSON.stringify(workflows);
      if (typeof runs === "string" || runs === null) return runs;
      const id = Number(args[args.indexOf("--workflow") + 1]);
      return JSON.stringify(listing(runs[id] ?? [], args));
    };
  const at = (minute: number) =>
    `2026-01-01T00:${String(minute).padStart(2, "0")}:00Z`;
  /** GitHub through `gh`, on the day after the runs `at` creates. */
  const github = (root: string, gh: Gh) =>
    githubAt(root, gh, () => new Date("2026-01-02T00:00:00Z"));

  test("is the newest run of the release workflow on the branch", () => {
    const seen: string[][] = [];
    const run = github(
      "/x",
      answering(
        {
          1: [
            {
              status: "completed",
              conclusion: "failure",
              createdAt: at(1),
            },
            {
              status: "completed",
              conclusion: "success",
              url: "https://u",
              headSha: "abcdef0123",
              createdAt: at(2),
            },
          ],
        },
        [
          { id: 1, name: "release" },
          { id: 2, name: "gates" },
        ],
        seen,
      ),
    ).lastReleaseRun("main");
    expect(run).toEqual({
      state: "success",
      detail: "the last release run on abcdef0 succeeded",
      url: "https://u",
    });
    const listed = seen.filter((args) => args[0] === "run");
    expect(listed.length).toBeGreaterThan(0);
    for (const args of listed) {
      expect(args).toContain("main");
      expect(args[args.indexOf("--workflow") + 1]).toBe("1");
    }
  });

  test("only a workflow named release counts, not one that mentions the word", () => {
    const state = (name: string) =>
      github(
        "/x",
        answering({ 7: [{ status: "completed", conclusion: "success" }] }, [
          { id: 7, name },
        ]),
      ).lastReleaseRun("main").state;
    expect([state("release"), state("Release"), state(" RELEASE ")]).toEqual([
      "success",
      "success",
      "success",
    ]);
    for (const name of ["Release Drafter", "pre-release checks", "releases"])
      expect([name, state(name)]).toEqual([name, "none"]);
  });

  test("an older release run still going answers before a newer one that ended", () => {
    const run = github(
      "/x",
      answering({
        1: [
          { status: "completed", conclusion: "cancelled", createdAt: at(3) },
          {
            status: "in_progress",
            url: "https://older",
            headSha: "0123456789",
            createdAt: at(2),
          },
          { status: "completed", conclusion: "success", createdAt: at(1) },
        ],
      }),
    ).lastReleaseRun("main");
    expect(run).toEqual({
      state: "running",
      detail: "a release run on 0123456 is still going",
      url: "https://older",
    });
  });

  /** 100 runs that ended, created after the minute `from`, one second apart. */
  const ended = (from: number) =>
    Array.from({ length: 100 }, (_, i) => ({
      databaseId: 1000 + i,
      status: "completed",
      conclusion: "cancelled",
      createdAt: `2026-01-01T00:${String(from + 1 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
    }));

  test("a release run still going answers behind a full window of newer runs that ended", () => {
    const buried = {
      databaseId: 1,
      status: "in_progress",
      url: "https://buried",
      createdAt: at(1),
    };
    expect(
      github("/x", answering({ 1: [buried, ...ended(1)] })).lastReleaseRun(
        "main",
      ),
    ).toMatchObject({ state: "running", url: "https://buried" });
  });

  test("a release run whose status changes between listings is still seen going", () => {
    // Waiting for approval, then going once approved, then waiting again on
    // its next job: whichever status each listing finds, it is still going.
    const statuses = ["waiting", "in_progress", "queued", "waiting"];
    let calls = 0;
    const runs = ended(1);
    const gh: Gh = (args) => {
      if (args[0] === "workflow")
        return JSON.stringify([{ id: 1, name: "release" }]);
      const buried = {
        databaseId: 1,
        status: statuses[calls++ % statuses.length],
        url: "https://buried",
        createdAt: at(1),
      };
      return JSON.stringify(listing([buried, ...runs], args));
    };
    expect(github("/x", gh).lastReleaseRun("main")).toMatchObject({
      state: "running",
      url: "https://buried",
    });
  });

  test("runs created before the horizon have ended, and the newest of them answers alone", () => {
    const seen: string[][] = [];
    const old = [
      {
        status: "completed",
        conclusion: "success",
        createdAt: "2025-06-01T00:00:00Z",
      },
      { status: "in_progress", createdAt: "2025-05-01T00:00:00Z" },
    ];
    expect(
      github("/x", answering({ 1: old }, undefined, seen)).lastReleaseRun(
        "main",
      ).state,
    ).toBe("success");
    const horizon = seen.find((args) => args.includes("--created"));
    expect(horizon?.[horizon.indexOf("--created") + 1]).toBe(
      ">=2025-10-28T00:00:00Z",
    );
  });

  test("a listing gh cut short at its limit answers unknown", () => {
    const workflows = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 2,
      name: `w${i}`,
    }));
    expect(
      github("/x", answering({}, workflows)).lastReleaseRun("main").state,
    ).toBe("unknown");
    // More runs created in one second than one listing holds.
    const sameSecond = Array.from({ length: 100 }, (_, i) => ({
      databaseId: i,
      status: "completed",
      conclusion: "success",
      createdAt: at(5),
    }));
    expect(
      github("/x", answering({ 1: sameSecond })).lastReleaseRun("main").state,
    ).toBe("unknown");
    // More runs since the horizon than the listings may take.
    const many = Array.from({ length: 2100 }, (_, i) => ({
      databaseId: i,
      status: "completed",
      conclusion: "success",
      createdAt: new Date(Date.parse(at(0)) - i * 1000).toISOString(),
    }));
    expect(
      github("/x", answering({ 1: many })).lastReleaseRun("main").state,
    ).toBe("unknown");
    // A run without a creation time leaves the next listing nowhere to start.
    const timeless = ended(1).map(({ createdAt: _, ...run }) => run);
    const gh: Gh = (args) =>
      JSON.stringify(
        args[0] === "workflow" ? [{ id: 1, name: "release" }] : timeless,
      );
    expect(github("/x", gh).lastReleaseRun("main").state).toBe("unknown");
  });

  test("runs of every workflow named release are read and the newest answers", () => {
    const run = github(
      "/x",
      answering(
        {
          1: [{ status: "completed", conclusion: "failure", createdAt: at(1) }],
          2: [{ status: "completed", conclusion: "success", createdAt: at(2) }],
        },
        [
          { id: 1, name: "release" },
          { id: 2, name: "Release" },
        ],
      ),
    ).lastReleaseRun("main");
    expect(run.state).toBe("success");
  });

  test("failed, running, none and unknown", () => {
    const state = (gh: Gh) => github("/x", gh).lastReleaseRun("main").state;
    expect(
      state(
        answering({ 1: [{ status: "completed", conclusion: "cancelled" }] }),
      ),
    ).toBe("failure");
    expect(state(answering({ 1: [{ status: "in_progress" }] }))).toBe(
      "running",
    );
    expect(state(answering({ 1: [] }))).toBe("none");
    expect(state(answering({}, [{ id: 2, name: "gates" }]))).toBe("none");
    expect(state(answering(null))).toBe("unknown");
    expect(state(answering("not json"))).toBe("unknown");
    expect(state(() => null)).toBe("unknown");
    expect(state((args) => (args[0] === "workflow" ? "not json" : "[]"))).toBe(
      "unknown",
    );
  });

  test("only a GitHub origin has an adapter, so another host or none degrades to no answer", () => {
    const gh: Gh = () => null;
    const root = repository({ "a.txt": "x" });
    expect(hostingFor(root, gh)).toBeNull();
    git(root, "remote", "add", "origin", "https://gitlab.com/o/r.git");
    expect(hostingFor(root, gh)).toBeNull();
    git(root, "remote", "set-url", "origin", "git@github.com:o/r.git");
    expect(hostingFor(root, gh)?.name).toBe("GitHub");
    // gh missing: the default branch is unknown and no command throws.
    expect(hostingFor(root, gh)?.defaultBranch()).toBeNull();
  });
});

describe("which branch is which", () => {
  const env = (extra: Record<string, string> = {}) => ({
    JIG_HOME: temporary(),
    ...extra,
  });
  /** A clone whose origin/HEAD names `main`. */
  function clone(files: Record<string, string> = { "a.txt": "x" }): string {
    const root = repository(files);
    git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    return root;
  }

  test("the default branch is origin/HEAD's, then the hosting service's", () => {
    const root = clone();
    expect(defaultBranch(root, null)).toBe("main");
    const bare = repository({ "a.txt": "x" });
    expect(defaultBranch(bare, null)).toBeNull();
    expect(
      defaultBranch(
        bare,
        stub(() => ({ state: "none", detail: "" })),
      ),
    ).toBe("main");
  });

  test("a push in CI has no pull request, so the event's default branch is the base, with no origin/HEAD and no gh", () => {
    const root = repository({ "a.txt": "x" });
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const event = temporary();
    write(
      event,
      "push.json",
      JSON.stringify({
        ref: "refs/heads/main",
        repository: { default_branch: "main" },
      }),
    );
    expect(
      checkBase(
        root,
        null,
        env({ GITHUB_EVENT_PATH: `${event}/push.json` }),
        null,
      ),
    ).toBe("origin/main");
  });

  test("the base of a check is --base, else the pull request's base, else the default branch", () => {
    const root = clone();
    expect(checkBase(root, "release/1", env(), null)).toBe("release/1");
    expect(checkBase(root, null, env(), null)).toBe("origin/main");
    expect(
      checkBase(root, null, env({ GITHUB_BASE_REF: "develop" }), null),
    ).toBe("origin/develop");
    const event = temporary();
    write(
      event,
      "event.json",
      JSON.stringify({
        pull_request: { base: { ref: "stable" } },
        repository: { default_branch: "main" },
      }),
    );
    expect(
      checkBase(
        root,
        null,
        env({ GITHUB_EVENT_PATH: `${event}/event.json` }),
        null,
      ),
    ).toBe("origin/stable");
    const bare = repository({ "a.txt": "x" });
    expect(checkBase(bare, null, env(), null)).toBeNull();
  });

  test("never repository.base_branch of the branch's own tree", () => {
    const root = clone({
      "a.txt": "x",
      ".config/jig.yaml": "repository:\n  base_branch: weaker\n",
    });
    expect(checkBase(root, null, env(), null)).toBe("origin/main");
    expect(integrationBranch(root, env(), null)).toBe("weaker");
  });

  test("the integration branch comes from the event's default branch in CI, else the clone", () => {
    const root = clone();
    const event = temporary();
    write(
      event,
      "event.json",
      JSON.stringify({ repository: { default_branch: "trunk" } }),
    );
    expect(
      integrationBranch(
        root,
        env({ GITHUB_EVENT_PATH: `${event}/event.json` }),
        null,
      ),
    ).toBe("trunk");
    expect(integrationBranch(root, env(), null)).toBe("main");
    // An unreadable event is no event.
    write(event, "bad.json", "{");
    expect(
      integrationBranch(
        root,
        env({ GITHUB_EVENT_PATH: `${event}/bad.json` }),
        null,
      ),
    ).toBe("main");
  });

  test("a branch's remote-tracking name is preferred to a local one", () => {
    const root = clone();
    git(root, "branch", "side");
    expect(remoteRef(root, "main")).toBe("origin/main");
    expect(remoteRef(root, "side")).toBe("side");
    expect(remoteRef(root, "missing")).toBe("origin/missing");
  });
});

import { describe, expect, test } from "bun:test";
import {
  checkBase,
  defaultBranch,
  integrationBranch,
  remoteRef,
} from "../scripts/branches.ts";
import {
  github,
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
  const answering =
    (out: string | null, seen: string[][] = []): Gh =>
    (args) => {
      seen.push(args);
      return out;
    };
  const runs = (list: object[]) => JSON.stringify(list);

  test("is the newest run of the release workflow on the branch", () => {
    const seen: string[][] = [];
    const run = github(
      "/x",
      answering(
        runs([
          { workflowName: "gates", status: "completed", conclusion: "failure" },
          {
            workflowName: "release",
            status: "completed",
            conclusion: "success",
            url: "https://u",
            headSha: "abcdef0123",
          },
          {
            workflowName: "release",
            status: "completed",
            conclusion: "failure",
          },
        ]),
        seen,
      ),
    ).lastReleaseRun("main");
    expect(run).toEqual({
      state: "success",
      detail: "the last release run on abcdef0 succeeded",
      url: "https://u",
    });
    expect(seen[0]).toContain("main");
  });

  test("only a workflow named release counts, not one that mentions the word", () => {
    const state = (name: string) =>
      github(
        "/x",
        answering(
          runs([
            { workflowName: name, status: "completed", conclusion: "success" },
          ]),
        ),
      ).lastReleaseRun("main").state;
    expect([state("release"), state("Release"), state(" RELEASE ")]).toEqual([
      "success",
      "success",
      "success",
    ]);
    for (const name of ["Release Drafter", "pre-release checks", "releases"])
      expect([name, state(name)]).toEqual([name, "none"]);
  });

  test("failed, running, none and unknown", () => {
    const state = (out: string | null) =>
      github("/x", answering(out)).lastReleaseRun("main").state;
    expect(
      state(
        runs([
          {
            workflowName: "release",
            status: "completed",
            conclusion: "cancelled",
          },
        ]),
      ),
    ).toBe("failure");
    expect(
      state(runs([{ workflowName: "Release", status: "in_progress" }])),
    ).toBe("running");
    expect(
      state(
        runs([
          { workflowName: "gates", status: "completed", conclusion: "success" },
        ]),
      ),
    ).toBe("none");
    expect(state(null)).toBe("unknown");
    expect(state("not json")).toBe("unknown");
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

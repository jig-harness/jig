import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { openTracker } from "../scripts/lib/tracker/index.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import { gitHubClient } from "../scripts/lib/tracker/github/client.ts";
import { gitHubModel } from "../scripts/lib/tracker/github/model.ts";
import { gitHubTracker } from "../scripts/lib/tracker/github/tracker.ts";
import {
  homeRepo,
  parseRef,
  repoFromRemote,
} from "../scripts/lib/tracker/github/refs.ts";
import {
  GitHubApiError,
  httpTransport,
  unwrapResponse,
} from "../scripts/lib/tracker/github/transport.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const HOME = { owner: "acme", name: "app" };

/** The error `f` throws; fails the test when it returns. */
function thrown(f: () => unknown): GitHubApiError {
  try {
    f();
  } catch (e) {
    return e as GitHubApiError;
  }
  throw new GitHubApiError("expected a throw");
}

describe("issue_tracker.github", () => {
  it("defaults to labels, the origin remote and priority labels", () => {
    const { github } = parseTrackerConfig({
      issue_tracker: { adapter: "github" },
    });
    expect(github).toEqual({
      repository: null,
      statesFrom: "labels",
      project: null,
      statusField: "Status",
      priorityLabels: {
        urgent: "priority: urgent",
        high: "priority: high",
        medium: "priority: medium",
        low: "priority: low",
      },
    });
  });

  it("reads a board by its web address", () => {
    const { github } = parseTrackerConfig({
      issue_tracker: {
        github: {
          states_from: "project",
          project: "https://github.com/users/dana/projects/3",
          status_field: "Stage",
          priority_labels: { urgent: "P0" },
        },
      },
    });
    expect(github.project).toEqual({
      url: "https://github.com/users/dana/projects/3",
      ownerType: "user",
      owner: "dana",
      number: 3,
    });
    expect(github.statusField).toBe("Stage");
    expect(github.priorityLabels.urgent).toBe("P0");
  });

  it("refuses a priority label that is also a state label, in labels mode only", () => {
    const overlay = (states_from: string) => ({
      issue_tracker: {
        adapter: "github",
        github: {
          states_from,
          project: "https://github.com/users/dana/projects/3",
          priority_labels: { high: "in progress" },
        },
      },
    });
    expect(() => parseTrackerConfig(overlay("labels"))).toThrow(
      "issue_tracker.github.priority_labels.high names 'in progress', which is also the label of a state",
    );
    expect(() => parseTrackerConfig(overlay("project"))).not.toThrow();
  });

  it("refuses what it cannot use, naming the field", () => {
    const refuse = (github: Record<string, unknown>, message: string) =>
      expect(() => parseTrackerConfig({ issue_tracker: { github } })).toThrow(
        message,
      );
    refuse(
      { repository: "app" },
      "issue_tracker.github.repository must be owner/name",
    );
    refuse(
      { states_from: "board" },
      "issue_tracker.github.states_from must be one of labels, project",
    );
    refuse(
      { states_from: "project" },
      "issue_tracker.github.project must name the board",
    );
    refuse(
      { project: "https://github.com/acme/app/projects/1" },
      "board's web address",
    );
    refuse(
      { priority_labels: { p1: "x" } },
      "priority_labels.p1 is not a priority",
    );
    refuse({ priority_labels: { urgent: "P", high: "p" } }, "names 'p' twice");
    refuse({ colour: "red" }, "issue_tracker.github.colour is not a field");
  });

  it("opens without a team, and Linear still requires one", () => {
    const github = openTracker(
      parseTrackerConfig({
        issue_tracker: {
          adapter: "github",
          github: { repository: "acme/app" },
        },
      }),
    );
    expect(github.adapter).toBe("github");
    expect(github.team).toBe("acme/app");
    expect(() =>
      openTracker(parseTrackerConfig({ issue_tracker: { adapter: "linear" } })),
    ).toThrow("issue_tracker.team");
  });

  it("derives the repository from the consumer root, not the working directory", () => {
    const base = mkdtempSync(join(tmpdir(), "tracker-root-"));
    try {
      const repo = (name: string, origin: string): string => {
        const path = join(base, name);
        for (const args of [
          ["init", "-q", path],
          ["-C", path, "remote", "add", "origin", origin],
        ]) {
          const r = Bun.spawnSync(["git", ...args], {
            stdout: "pipe",
            stderr: "pipe",
          });
          expectSpawnExit(
            {
              exitCode: r.exitCode,
              stdout: r.stdout.toString(),
              stderr: r.stderr.toString(),
            },
            0,
          );
        }
        return path;
      };
      const cwd = repo("cwd", "https://github.com/acme/cwd.git");
      const consumer = repo("consumer", "https://github.com/acme/consumer.git");
      const modules = join(import.meta.dir, "..", "scripts", "lib", "tracker");
      const r = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { parseTrackerConfig } from ${JSON.stringify(join(modules, "config.ts"))};
           import { openTracker } from ${JSON.stringify(join(modules, "index.ts"))};
           console.log(openTracker(parseTrackerConfig({ issue_tracker: { adapter: "github" } })).team);`,
        ],
        {
          cwd,
          env: { ...process.env, JIG_CONSUMER_ROOT: consumer },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = r.stdout.toString();
      expectSpawnExit(
        { exitCode: r.exitCode, stdout, stderr: r.stderr.toString() },
        0,
      );
      expect(stdout.trim()).toBe("acme/consumer");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the reachability probe", () => {
  it("hands its signal to the request it makes, on either adapter", async () => {
    const config = parseTrackerConfig({
      issue_tracker: { adapter: "github", github: { repository: "acme/app" } },
    });
    const seen: Array<AbortSignal | undefined> = [];
    const github = gitHubTracker(
      gitHubClient({
        home: HOME,
        model: gitHubModel(config.states, config.github),
        settings: config.github,
        transport: async (_q, _v, signal) => {
          seen.push(signal);
          if (signal?.aborted === true) throw new Error("aborted");
          return { repository: { id: "R_1" } };
        },
      }),
    );
    const linear = linearTracker({
      team: "ENG",
      states: config.states,
      transport: async (_q, _v, signal) => {
        seen.push(signal);
        throw new Error("aborted");
      },
    });
    const deadline = new AbortController();
    deadline.abort();
    await expect(github.reach(deadline.signal)).rejects.toThrow("aborted");
    await expect(linear.reach(deadline.signal)).rejects.toThrow("aborted");
    expect(seen).toEqual([deadline.signal, deadline.signal]);
    // An aborted probe leaves nothing behind for the next caller.
    await github.reach();
    expect(seen).toHaveLength(3);
  });
});

describe("GitHub issue references", () => {
  it("reads every form of a key", () => {
    expect(parseRef("#12", HOME)).toEqual({ ...HOME, number: 12 });
    expect(parseRef(" 12 ", HOME)).toEqual({ ...HOME, number: 12 });
    expect(parseRef("other/lib#3", HOME)).toEqual({
      owner: "other",
      name: "lib",
      number: 3,
    });
    expect(
      parseRef("https://github.com/other/lib/issues/4#issuecomment-1", HOME),
    ).toEqual({
      owner: "other",
      name: "lib",
      number: 4,
    });
    for (const bad of [
      "ENG-1",
      "#0",
      "#",
      "https://github.com/acme/app/pull/5",
      "",
    ])
      expect(parseRef(bad, HOME)).toBeNull();
  });

  it("derives the repository from the origin remote, or names the field", () => {
    for (const url of [
      "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app",
      "https://github.com/acme/app.git",
      "https://token@github.com/acme/app/",
    ])
      expect(repoFromRemote(url)).toEqual(HOME);
    expect(repoFromRemote("https://gitlab.com/acme/app.git")).toBeNull();
    expect(homeRepo("x/y", () => null)).toEqual({ owner: "x", name: "y" });
    expect(homeRepo(null, () => "git@github.com:acme/app.git")).toEqual(HOME);
    expect(() => homeRepo(null, () => "https://gitlab.com/a/b")).toThrow(
      "issue_tracker.github.repository is not set",
    );
  });
});

describe("GitHub transport", () => {
  it("tells a missing thing and a rate limit from other errors, keeping partial data", () => {
    const missing = thrown(() =>
      unwrapResponse({
        data: { repository: { issue: null } },
        errors: [{ type: "NOT_FOUND" }],
      }),
    );
    expect(missing.notFound).toBe(true);
    expect(missing.data).toEqual({ repository: { issue: null } });
    const limited = thrown(() =>
      unwrapResponse({ errors: [{ type: "RATE_LIMITED" }] }),
    );
    expect([limited.notFound, limited.unavailable]).toEqual([false, true]);
    expect(unwrapResponse({ data: { ok: 1 } })).toEqual({ ok: 1 });
    expect(() => unwrapResponse({})).toThrow("no data");
  });

  it("sends a bearer token over https and reads an error status", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const respond = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const ok = httpTransport(
      "https://ghe.example/api/graphql",
      "t0k",
      respond(200, { data: { ok: 1 } }),
    );
    expect(await ok("query { ok }", {})).toEqual({ ok: 1 });
    expect(seen[0]).toEqual({
      url: "https://ghe.example/api/graphql",
      auth: "bearer t0k",
    });
    const timedOut = httpTransport(
      "https://ghe.example/api/graphql",
      "t0k",
      respond(502, {
        data: null,
        errors: [{ message: "Something went wrong; this may be a timeout" }],
      }),
    );
    const slow = (await timedOut("query { ok }", {}).catch(
      (e: unknown) => e,
    )) as GitHubApiError;
    expect([slow.unavailable, slow.notFound]).toEqual([true, false]);
    const down = httpTransport(
      "https://ghe.example/api/graphql",
      "t0k",
      respond(502, "bad gateway"),
    );
    const err = (await down("query { ok }", {}).catch(
      (e: unknown) => e,
    )) as GitHubApiError;
    expect(err.unavailable).toBe(true);
    expect(() => httpTransport("http://ghe.example/graphql", "t")).toThrow(
      "loopback",
    );
    expect(() =>
      httpTransport("http://127.0.0.1:9/graphql", "t"),
    ).not.toThrow();
  });

  describe("through gh", () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    /** Run `ghTransport` in a child whose PATH starts with a stand-in `gh`. */
    async function viaGh(
      script: string,
    ): Promise<{ code: number | null; out: string; err: string }> {
      dir = mkdtempSync(join(tmpdir(), "gh-transport-"));
      writeFakeProgram(join(dir, "gh"), script);
      const transport = join(
        import.meta.dir,
        "..",
        "scripts",
        "lib",
        "tracker",
        "github",
        "transport.ts",
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { ghTransport } from ${JSON.stringify(transport)};
           try { console.log(JSON.stringify(await ghTransport()("query Q { ok }", { n: 1 }))); }
           catch (e) { console.error(e.message, JSON.stringify({ notFound: e.notFound, unavailable: e.unavailable })); process.exit(3); }`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, out, err };
    }

    it("sends the request on stdin and returns the data", async () => {
      const r = await viaGh(`#!/usr/bin/env bun
        const body = JSON.parse(await Bun.stdin.text());
        console.log(JSON.stringify({ data: { args: process.argv.slice(2), variables: body.variables } }));
      `);
      expectSpawnExit({ exitCode: r.code, stdout: r.out, stderr: r.err }, 0);
      expect(JSON.parse(r.out)).toEqual({
        args: ["api", "graphql", "--input", "-"],
        variables: { n: 1 },
      });
    });

    it("reports a signed-out gh as unavailable", async () => {
      const r = await viaGh(
        `#!/bin/sh\necho 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4\n`,
      );
      expectSpawnExit({ exitCode: r.code, stdout: r.out, stderr: r.err }, 3);
      expect(r.err).toContain('"unavailable":true');
    });

    it("reports the errors of a failed run whose output parses", async () => {
      const r = await viaGh(
        `#!/bin/sh\nprintf '%s' '{"data":{"repository":{"issue":null}},"errors":[{"type":"NOT_FOUND"}]}'\nexit 1\n`,
      );
      expectSpawnExit({ exitCode: r.code, stdout: r.out, stderr: r.err }, 3);
      expect(r.err).toContain('"notFound":true');
    });
  });
});

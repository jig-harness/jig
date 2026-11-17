import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { conn, issueNode, oneIssue } from "./github-fixtures.ts";
import { footprintOperations } from "../scripts/lib/footprint-ops.ts";
import { trackerFootprints } from "../scripts/lib/tracker/footprints.ts";
import type { Issue } from "../scripts/lib/tracker/port.ts";
import { OutboundError } from "../../../shared/outbound/failure.ts";

function harness(
  raw = JSON.stringify({
    source: "filing",
    base: "abcdef0",
    paths: ["src/"],
    areas: [],
  }),
) {
  const posted: string[] = [],
    opened: string[] = [];
  const comments = {
    async issueComments() {
      return { uuid: "id", comments: [] };
    },
    async postComment(_key: string, body: string) {
      posted.push(body);
    },
  };
  const t = {
    ...trackerFootprints(comments, true),
    async getIssue() {
      return {
        identifier: "#42",
        updatedAt: "2026-11-14T00:00:00Z",
        labels: ["area:api"],
      } as Issue;
    },
  };
  const op = footprintOperations({
    tracker: () => {
      opened.push("tracker");
      return t;
    },
    readInput: async () => raw,
    areaLabels: () => ({ api: ["area:api"] }),
  }).footprint;
  return {
    run: (input?: string, key = "#42") => op?.run([key], new Set(), input),
    posted,
    opened,
  };
}
test("footprint command reads catalog seeds without claiming an active pickup", async () => {
  expect(await harness().run()).toMatchObject({
    key: "#42",
    source: "labels",
    areas: ["api"],
    record: null,
  });
});
test("footprint command writes input payload with host-generated envelope", async () => {
  const h = harness();
  expect(await h.run("input.json")).toMatchObject({
    issue: "#42",
    written: true,
  });
  expect(h.posted).toHaveLength(1);
  expect(h.posted[0]).toContain('"host":"sha256:');
  expect(h.posted[0]).toContain('"key":"#42"');
});
test("invalid JSON, mismatched keys and invalid paths never open the tracker or write", async () => {
  for (const raw of [
    "{",
    "null",
    '{"key":"#43","source":"filing","base":"abcdef0","paths":[],"areas":[]}',
    '{"source":"filing","base":"abcdef0","paths":["../escape"],"areas":[]}',
    '{"writer":{},"source":"filing","base":"abcdef0","paths":[],"areas":[]}',
  ]) {
    const h = harness(raw);
    await expect(h.run("input.json")).rejects.toThrow();
    expect(h.posted).toEqual([]);
    expect(h.opened).toEqual([]);
  }
});
test("a malformed command key is refused before constructing a tracker", async () => {
  const h = harness();
  await expect(h.run("input.json", "../invalid")).rejects.toThrow();
  expect(h.opened).toEqual([]);
  expect(h.posted).toEqual([]);
});
test("expected footprint input failures preserve their typed cause", async () => {
  await expect(harness("{").run("input.json")).rejects.toMatchObject({
    code: "invalid",
    cause: expect.any(SyntaxError),
  });
  const badPath = JSON.stringify({
    source: "filing",
    base: "abcdef0",
    paths: ["../escape"],
    areas: [],
  });
  await expect(harness(badPath).run("input.json")).rejects.toMatchObject({
    code: "invalid",
    cause: expect.any(OutboundError),
  });
});

test.if(platform() !== "win32")(
  "footprint refuses a FIFO input without waiting for a writer",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-footprint-fifo-"));
    const input = join(dir, "prediction.json");
    try {
      const fifo = Bun.spawn(["mkfifo", input], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [fifoExitCode, fifoStdout, fifoStderr] = await Promise.all([
        fifo.exited,
        new Response(fifo.stdout).text(),
        new Response(fifo.stderr).text(),
      ]);
      expectSpawnExit(
        { exitCode: fifoExitCode, stdout: fifoStdout, stderr: fifoStderr },
        0,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/tracker.ts"),
          "footprint",
          "#42",
          "--input",
          input,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 5_000 },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expectSpawnExit({ exitCode, stdout, stderr }, 2);
      expect(stderr).toContain("input must be a regular file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("tracker.ts wires footprint read and --input through its operation registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-footprint-cli-"));
  const queries: string[] = [];
  let posted = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { query, variables } = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      queries.push(query);
      let data: unknown;
      if (query.includes("mutation")) {
        posted = String(variables.body);
        data = { addComment: { commentEdge: { node: { id: "C1" } } } };
      } else if (query.includes("TrackerComments"))
        data = { repository: { issue: { id: "I42", comments: conn([]) } } };
      else
        data = oneIssue(
          issueNode({ number: 42, extra: { subIssues: conn([]) } }),
        );
      return Response.json({ data });
    },
  });
  try {
    mkdirSync(join(dir, ".config"));
    writeFileSync(
      join(dir, ".config/jig.yaml"),
      "issue_tracker:\n  adapter: github\n  github:\n    repository: acme/app\n  facets:\n    type: {store: label}\n    priority: {store: label}\n",
    );
    const input = join(dir, "prediction.json");
    writeFileSync(
      input,
      JSON.stringify({
        source: "filing",
        base: "abcdef0",
        paths: ["src/"],
        areas: [],
      }),
    );
    const env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      JIG_CONSUMER_ROOT: dir,
      JIG_OVERLAY: join(dir, ".config/jig.yaml"),
      GH_TOKEN: "fixture-footprint-token",
      JIG_GITHUB_GRAPHQL_URL: server.url.toString(),
      JIG_OUTBOUND_CALLER: "test:footprint",
    };
    for (const args of [
      ["footprint", "#42"],
      ["footprint", "#42", "--input", input],
    ]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/tracker.ts"),
          ...args,
        ],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expectSpawnExit({ exitCode, stdout, stderr }, 0);
      expect(JSON.parse(stdout)).toMatchObject(
        args.length === 2
          ? { key: "#42", source: "unknown" }
          : { issue: "#42", written: true },
      );
    }
    expect(queries.some((q) => q.includes("TrackerComments"))).toBe(true);
    expect(posted).toContain('"kind":"tracker-footprint"');
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

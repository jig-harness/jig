import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  cliTransport,
  httpTransport,
  LinearApiError,
  type LinearTransport,
  linearTracker,
  pageAll,
  parseIssueFact,
  unwrapResponse,
} from "../scripts/lib/tracker/linear.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { processTable } from "../../../shared/process-table.ts";
import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

/**
 * Whether a process has ended within `ms`: gone from the process table, or
 * a zombie, which a host whose PID 1 does not reap leaves behind after a
 * successful kill.
 */
async function endsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = await processTable();
    if (
      rows !== null &&
      !rows.some((row) => row.pid === pid && !row.stat.startsWith("Z"))
    )
      return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const STATES = parseTrackerConfig({}).states;

type Call = { query: string; variables: Record<string, unknown> };

/** A fake transport answering each request with the next scripted response. */
function fake(answer: (call: Call, n: number) => unknown): {
  transport: LinearTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    transport: async (query, variables) => {
      const call = { query, variables };
      calls.push(call);
      const out = answer(call, calls.length - 1);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

function tracker(answer: (call: Call, n: number) => unknown) {
  const f = fake(answer);
  return {
    t: linearTracker({ team: "ENG", states: STATES, transport: f.transport }),
    calls: f.calls,
  };
}

const labels = (...names: string[]) => ({
  pageInfo: { hasNextPage: false },
  nodes: names.map((name) => ({ name })),
});
const page = (nodes: unknown[], next: string | null = null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
});

describe("Linear transport", () => {
  it("marks an entity-not-found answer as not found", () => {
    try {
      unwrapResponse(
        { errors: [{ message: "Entity not found: Issue" }], data: null },
        200,
      );
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LinearApiError);
      expect((err as LinearApiError).notFound).toBe(true);
    }
    expect(() =>
      unwrapResponse({ errors: [{ message: "boom" }] }, 200),
    ).toThrow("boom");
  });

  it("sends the key as Authorization and returns data", async () => {
    let seen: RequestInit | undefined;
    const t = httpTransport("lin_api_x", (async (
      _url: string,
      init: RequestInit,
    ) => {
      seen = init;
      return new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await t("query { ok }", {})).toEqual({ ok: 1 });
    const headers = (seen?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("lin_api_x");
  });

  it("starts no further page once the caller's signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const transport = async (
      _q: string,
      _v: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      if (signal?.aborted === true) throw new Error("aborted");
      calls++;
      controller.abort(new Error("deadline"));
      return {
        issues: {
          nodes: [{ identifier: `ENG-${calls}` }],
          pageInfo: { hasNextPage: true, endCursor: `c${calls}` },
        },
      };
    };
    await expect(
      pageAll(transport, "q", {}, (d) => d.issues, "issues", controller.signal),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });

  it("reports an HTTP error status", async () => {
    const t = httpTransport(
      "k",
      (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    );
    await expect(t("query { ok }", {})).rejects.toThrow("HTTP 500");
  });

  describe("command-line client", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });
    /** A stand-in `linear` printing `out` and exiting with `code`. */
    function client(out: string, code: number): string {
      dir = mkdtempSync(join(tmpdir(), "linear-cli-"));
      const bin = join(dir, "linear");
      writeFakeProgram(bin, `#!/bin/sh\nprintf '%s' '${out}'\nexit ${code}\n`);
      return bin;
    }

    it("returns the data of a successful invocation", async () => {
      const t = cliTransport(client('{"data":{"ok":1}}', 0));
      expect(await t("query { ok }", {})).toEqual({ ok: 1 });
    });

    it("rejects a failed invocation whose output parses as data", async () => {
      const t = cliTransport(client('{"data":{"ok":1}}', 1));
      await expect(t("query { ok }", {})).rejects.toThrow("exited 1");
    });

    it("kills the client when the caller's signal aborts", async () => {
      dir = mkdtempSync(join(tmpdir(), "linear-cli-"));
      const ready = join(dir, "client-ready");
      const bin = writeFakeProgram(
        join(dir, "linear"),
        `#!/usr/bin/env bun
        import {writeFileSync} from 'node:fs';
        writeFileSync(${JSON.stringify(ready)},String(process.pid));
        setInterval(()=>{},1000);
      `,
      );
      const controller = new AbortController();
      let pid = 0,
        started = 0;
      const cancelling = (async () => {
        const deadline = Date.now() + 15_000;
        while (!existsSync(ready) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        pid = Number(readFileSync(ready, "utf8"));
        started = Date.now();
        controller.abort(new Error("deadline"));
      })();
      await expect(
        cliTransport(bin)("query {ok}", {}, controller.signal),
      ).rejects.toThrow("Linear request cancelled: deadline");
      await cancelling;
      expect(pid).toBeGreaterThan(0);
      const limit = Number(
        byPlatform("Windows cancellation includes bounded CIM enumeration", {
          windows: "15000",
          posix: "5000",
        }),
      );
      expect(Date.now() - started).toBeLessThan(limit);
      expect(await endsWithin(pid, 10_000)).toBe(true);
    }, 60_000);

    it("ends a client whose descendant holds its output open", async () => {
      dir = mkdtempSync(join(tmpdir(), "linear-cli-"));
      const bin = join(dir, "linear");
      const pidFile = join(dir, "descendant.pid");
      const program = writeFakeProgram(
        bin,
        `#!/usr/bin/env bun
        import {writeFileSync} from 'node:fs';
        const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'inherit',stderr:'inherit'});
        writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
        await child.exited;
      `,
      );
      const controller = new AbortController();
      // Cancel once the descendant exists, however slowly the shell starts.
      let aborted = 0;
      void (async () => {
        const deadline = Date.now() + 10_000;
        while (
          Date.now() < deadline &&
          !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")
        )
          await new Promise((r) => setTimeout(r, 20));
        aborted = Date.now();
        controller.abort(new Error("deadline"));
      })();
      await expect(
        cliTransport(program)("query { ok }", {}, controller.signal),
      ).rejects.toThrow("Linear request cancelled: deadline");
      const limit = Number(
        byPlatform("Windows cleanup includes bounded CIM enumeration", {
          windows: "15000",
          posix: "5000",
        }),
      );
      expect(Date.now() - aborted).toBeLessThan(limit);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(await endsWithin(pid, 10_000)).toBe(true);
    }, 60_000);

    it("ends the client when the calling process is terminated", async () => {
      dir = mkdtempSync(join(tmpdir(), "linear-cli-"));
      const pidFile = join(dir, "client.pid"),
        request = join(dir, "console-request"),
        released = join(dir, "cleanup-ran");
      const bin = writeFakeProgram(
        join(dir, "linear"),
        `#!/usr/bin/env bun
        import {writeFileSync} from 'node:fs';
        writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
        setInterval(()=>{},1000);
      `,
      );
      const mode = byPlatform(
        "Windows uses a modeled console event so the parent's cancellation handler can run",
        { windows: "file", posix: "signal" },
      );
      const caller = join(dir, "caller.ts");
      writeFileSync(
        caller,
        `
        import {cliTransport} from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/tracker/linear.ts"))};
        import {registerCleanup} from ${JSON.stringify(join(import.meta.dir, "../../../shared/cleanup.ts"))};
        import {writeFileSync,existsSync,unlinkSync} from 'node:fs';
        registerCleanup(()=>writeFileSync(${JSON.stringify(released)},''));
        ${mode === "file" ? `setInterval(()=>{if(existsSync(${JSON.stringify(request)})){unlinkSync(${JSON.stringify(request)});process.emit('SIGTERM');}},25);` : ""}
        await cliTransport(${JSON.stringify(bin)})("query {ok}",{});
      `,
      );
      const child = Bun.spawn([process.execPath, caller], {
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 15_000;
        while (!existsSync(pidFile) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
        if (mode === "file") writeFileSync(request, "stop");
        else child.kill("SIGTERM");
        await expectSpawnExited(child, 143);
        expect(existsSync(released)).toBe(true);
        expect(await endsWithin(pid, 10_000)).toBe(true);
      } finally {
        child.kill();
        await child.exited;
      }
    }, 60_000);

    it("stops a client that prints more than it can hold", async () => {
      dir = mkdtempSync(join(tmpdir(), "linear-cli-"));
      const bin = join(dir, "linear");
      writeFakeProgram(bin, "#!/bin/sh\nhead -c 70000000 /dev/zero\n");
      await expect(cliTransport(bin)("query { ok }", {})).rejects.toThrow(
        "more output than can be held",
      );
    });

    it("reports the errors a failed invocation carries", async () => {
      const t = cliTransport(
        client('{"errors":[{"message":"Entity not found: Issue"}]}', 1),
      );
      try {
        await t("query { ok }", {});
        throw new Error("expected a throw");
      } catch (err) {
        expect(err).toBeInstanceOf(LinearApiError);
        expect((err as LinearApiError).notFound).toBe(true);
      }
    });
  });
});

describe("Linear adapter: issue pickup", () => {
  const issueNode = {
    id: "uuid-1",
    identifier: "ENG-1",
    title: "Parent",
    description: null,
    url: "https://tracker.example/ENG-1",
    updatedAt: "2026-10-01T00:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    labels: labels("epic"),
    parent: null,
    children: page([
      {
        identifier: "ENG-2",
        title: "Child",
        state: { name: "Done", type: "completed" },
        labels: labels("manual-ops"),
      },
    ]),
    assignee: { name: "Dev" },
    project: null,
  };

  it("reads an issue with its children", async () => {
    const { t } = tracker(() => ({ issue: issueNode }));
    const issue = await t.getIssue("ENG-1");
    expect(issue?.identifier).toBe("ENG-1");
    expect(issue?.description).toBe("");
    expect(issue?.labels).toEqual(["epic"]);
    expect(issue?.children[0]?.labels).toEqual(["manual-ops"]);
    expect([issue?.assignee, issue?.nativeType]).toEqual(["Dev", null]);
  });

  it("returns null for an issue the tracker does not have", async () => {
    const { t } = tracker(
      () => new LinearApiError("Entity not found", 200, true),
    );
    expect(await t.getIssue("ENG-404")).toBeNull();
  });

  it("returns null for an explicit null issue and fails an omitted one", async () => {
    const empty = tracker(() => ({ issue: null }));
    expect(await empty.t.getIssue("ENG-404")).toBeNull();
    const omitted = tracker(() => ({}));
    await expect(omitted.t.getIssue("ENG-1")).rejects.toThrow(
      "expected an object",
    );
  });

  it("refuses a truncated child list rather than reporting it complete", async () => {
    const { t } = tracker(() => ({
      issue: { ...issueNode, children: page([], "c1") },
    }));
    await expect(t.getIssue("ENG-1")).rejects.toThrow("children");
  });

  it("pages every comment, oldest first", async () => {
    const { t, calls } = tracker((_c, n) =>
      n === 0
        ? {
            issue: {
              id: "u",
              comments: page(
                [
                  {
                    id: "c2",
                    body: "second",
                    createdAt: "2026-01-02T00:00:00Z",
                  },
                ],
                "cur",
              ),
            },
          }
        : {
            issue: {
              id: "u",
              comments: page([
                { id: "c1", body: "first", createdAt: "2026-01-01T00:00:00Z" },
              ]),
            },
          },
    );
    const comments = await t.listComments("ENG-1");
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(calls[1]?.variables.after).toBe("cur");
  });

  it("transitions by the configured state name", async () => {
    const f = fake((call) => {
      if (call.query.includes("TrackerIssueId"))
        return { issue: { id: "uuid-1", team: { id: "team-1", key: "ENG" } } };
      if (call.query.includes("TrackerStates"))
        return {
          team: {
            states: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { id: "s-1", name: "Code Review", type: "started" },
                { id: "s-2", name: "Done", type: "completed" },
              ],
            },
          },
        };
      return { issueUpdate: { success: true } };
    });
    const t = linearTracker({
      team: "ENG",
      states: { ...STATES, in_review: "Code Review" },
      transport: f.transport,
    });
    await t.transition("ENG-1", "in_review");
    expect(f.calls.at(-1)?.variables).toEqual({
      id: "uuid-1",
      input: { stateId: "s-1" },
    });
    await expect(t.transition("ENG-1", "ops_pending")).rejects.toThrow(
      "matches 0 workflow states",
    );
  });

  it("refuses a comment the tracker did not accept", async () => {
    const { t, calls } = tracker((call) =>
      call.query.includes("TrackerIssueId")
        ? { issue: { id: "uuid-9", team: { id: "t" } } }
        : { commentCreate: { success: false } },
    );
    await expect(t.postComment("ENG-9", "hi")).rejects.toThrow(
      "did not succeed",
    );
    expect(calls.at(-1)?.variables).toEqual({ issueId: "uuid-9", body: "hi" });
  });
});

describe("Linear adapter: fleet metrics", () => {
  const fact = (identifier: string, extra: Record<string, unknown> = {}) => ({
    identifier,
    title: `t ${identifier}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    completedAt: null,
    description: "",
    state: { type: "started" },
    labels: labels(),
    parent: null,
    ...extra,
  });

  it("reads issues by key for the configured team only", async () => {
    const { t, calls } = tracker(() => ({ issues: page([fact("ENG-7")]) }));
    const got = await t.issuesByKeys(["ENG-7", "OPS-3", "ENG-7"]);
    expect([...got.keys()]).toEqual(["ENG-7"]);
    expect(calls[0]?.variables.numbers).toEqual([7]);
    expect(calls[0]?.variables.teamKey).toBe("ENG");
  });

  it("walks the parent chain and refuses one deeper than the walk", () => {
    const chain = (depth: number): unknown =>
      depth === 0
        ? null
        : {
            identifier: `ENG-${depth}`,
            labels: labels(),
            parent: chain(depth - 1),
          };
    expect(
      parseIssueFact(fact("ENG-99", { parent: chain(2) })).ancestors,
    ).toHaveLength(2);
    expect(() => parseIssueFact(fact("ENG-99", { parent: chain(6) }))).toThrow(
      "ancestors",
    );
  });

  it("filters a window read by label and range", async () => {
    const { t, calls } = tracker(() => ({ issues: page([]) }));
    await t.issuesInWindow({
      label: "follow-up",
      createdIn: { sinceMs: 0, untilMs: 86_400_000 },
    });
    expect(calls[0]?.variables.filter).toEqual({
      team: { key: { eq: "ENG" } },
      labels: { name: { eq: "follow-up" } },
      createdAt: {
        gte: "1970-01-01T00:00:00.000Z",
        lt: "1970-01-02T00:00:00.000Z",
      },
    });
  });

  it("refuses a repeated cursor", async () => {
    const { t } = tracker(() => ({ issues: page([], "same") }));
    await expect(t.issuesInWindow({})).rejects.toThrow("cursor");
  });

  it("marks comment authors trusted only when they are non-guest users", async () => {
    const { t } = tracker(() => ({
      comments: page([
        {
          id: "a",
          body: "x",
          createdAt: "2026-09-02T00:00:00Z",
          issue: { identifier: "ENG-1" },
          user: { id: "u1", guest: false },
        },
        {
          id: "b",
          body: "y",
          createdAt: "2026-09-02T00:00:00Z",
          issue: { identifier: "ENG-1" },
          user: { id: "u2", guest: true },
        },
        {
          id: "c",
          body: "z",
          createdAt: "2026-09-02T00:00:00Z",
          issue: { identifier: "ENG-1" },
          user: null,
        },
      ]),
    }));
    const found = await t.commentsContaining({
      text: "marker",
      issueLabel: "epic",
      createdIn: { sinceMs: 0, untilMs: 1 },
    });
    expect(found.map((c) => c.trusted)).toEqual([true, false, false]);
  });

  it("reads a ledger as one union and refuses an unresolved name", async () => {
    const ledgerNode = {
      identifier: "ENG-5",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: null,
      canceledAt: null,
      priority: 0,
      state: { type: "backlog" },
      labels: {
        pageInfo: { hasNextPage: true },
        nodes: [{ name: "follow-up" }],
      },
      parent: { identifier: "ENG-1" },
      project: null,
    };
    const resources = (projects: number) => ({
      issueLabels: page([{ id: "l", name: "follow-up" }]),
      projects: page(
        Array.from({ length: projects }, (_, i) => ({
          id: `p${i}`,
          name: "Debt",
        })),
      ),
    });
    const ok = tracker((call) =>
      call.query.includes("TrackerLedgerResources")
        ? resources(1)
        : { issues: page([ledgerNode]) },
    );
    const pages: number[] = [];
    const got = await ok.t.ledger(
      { label: "follow-up", project: "Debt" },
      (n) => pages.push(n),
    );
    expect(got[0]).toMatchObject({
      identifier: "ENG-5",
      parent: "ENG-1",
      truncated: ["labels"],
    });
    expect(pages).toEqual([1]);
    expect(ok.calls[1]?.query).toContain("or:");

    const missing = tracker(() => resources(0));
    await expect(
      missing.t.ledger({ label: "follow-up", project: "Debt" }),
    ).rejects.toThrow("matched 0");

    const labelOnly = tracker((call) =>
      call.query.includes("TrackerLedgerResources")
        ? { issueLabels: page([{ id: "l", name: "follow-up" }]) }
        : { issues: page([]) },
    );
    expect(await labelOnly.t.ledger({ label: "follow-up" })).toEqual([]);
    expect(labelOnly.calls[1]?.query).not.toContain("or:");
  });

  it("refuses a completed labelled issue without a completion time", async () => {
    const { t } = tracker(() => ({
      issues: page([
        {
          identifier: "ENG-1",
          completedAt: null,
          state: { type: "completed" },
        },
      ]),
    }));
    await expect(t.labelledIssues("epic")).rejects.toThrow("completedAt");
  });

  it("reads descriptions only when asked", async () => {
    const node = {
      identifier: "ENG-1",
      completedAt: null,
      description: "Jig owner: repository:example/web",
      state: { type: "started" },
    };
    const { description: _omitted, ...bare } = node;
    const plain = tracker(() => ({ issues: page([bare]) }));
    expect(await plain.t.labelledIssues("pattern:x")).toEqual([
      { identifier: "ENG-1", stateType: "started", completedAt: null },
    ]);
    expect(plain.calls[0]?.query).not.toContain("description");
    const described = tracker(() => ({
      issues: page([node, { ...node, identifier: "ENG-2", description: null }]),
    }));
    const got = await described.t.labelledIssues("pattern:x", undefined, true);
    expect(described.calls[0]?.query).toContain("description");
    expect(got.map((i) => [i.identifier, i.description])).toEqual([
      ["ENG-1", "Jig owner: repository:example/web"],
      ["ENG-2", null],
    ]);
  });

  it("refuses a requested description that is absent or not a string", async () => {
    const node = {
      identifier: "ENG-1",
      completedAt: null,
      state: { type: "started" },
    };
    for (const bad of [
      node,
      { ...node, description: 42 },
      { ...node, description: {} },
    ]) {
      const { t } = tracker(() => ({ issues: page([bad]) }));
      await expect(
        t.labelledIssues("pattern:x", undefined, true),
      ).rejects.toThrow("description was requested");
    }
  });
});

describe("Linear adapter: candidate pools", () => {
  const poolNode = (
    identifier: string,
    extra: Record<string, unknown> = {},
  ) => ({
    identifier,
    title: `t ${identifier}`,
    url: `https://tracker.example/${identifier}`,
    priority: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    assignee: null,
    labels: labels("small", "area:docs"),
    children: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...extra,
  });

  it("filters an open pool by team, open state and each label clause", async () => {
    const { t, calls } = tracker(() => ({ issues: page([poolNode("ENG-4")]) }));
    const got = await t.openIssues({
      withSomeOf: [["area:docs"], ["xs", "small"]],
    });
    expect(got.map((i) => i.identifier)).toEqual(["ENG-4"]);
    expect(calls[0]?.variables.filter).toEqual({
      and: [
        { team: { key: { eq: "ENG" } } },
        { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
        { labels: { name: { in: ["area:docs"] } } },
        { labels: { name: { in: ["xs", "small"] } } },
      ],
    });
  });

  it("excludes labels with every-not-in, not some-not-in", async () => {
    const { t, calls } = tracker(() => ({ issues: page([]) }));
    await t.openIssues({
      withSomeOf: [["area:docs"]],
      withNoneOf: ["xs", "small", "large"],
    });
    const filter = calls[0]?.variables.filter as { and: unknown[] } | undefined;
    expect(filter?.and.at(-1)).toEqual({
      labels: { every: { name: { nin: ["xs", "small", "large"] } } },
    });
  });

  it("refuses a pool query that would read every open issue", async () => {
    const { t, calls } = tracker(() => ({ issues: page([]) }));
    await expect(t.openIssues({ withSomeOf: [] })).rejects.toThrow(
      "every open issue",
    );
    await expect(t.openIssues({ withSomeOf: [["a"], []] })).rejects.toThrow(
      "every open issue",
    );
    expect(calls).toHaveLength(0);
  });

  it("reads ids beside names, open children, and a truncated label page", async () => {
    const { t } = tracker(() => ({
      issues: page([
        poolNode("ENG-1", {
          assignee: { id: "u-1", name: "Sam" },
          labels: { pageInfo: { hasNextPage: true }, nodes: [{ name: "xs" }] },
          children: { pageInfo: { hasNextPage: false }, nodes: [{ id: "c" }] },
        }),
        poolNode("ENG-2"),
      ]),
    }));
    const [first, second] = await t.openIssues({ withSomeOf: [["xs"]] });
    expect(first).toMatchObject({
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
      assignee: { id: "u-1", name: "Sam" },
      hasOpenChildren: true,
      truncated: ["labels"],
    });
    expect(second).toMatchObject({
      assignee: null,
      hasOpenChildren: false,
      truncated: [],
      labels: ["small", "area:docs"],
    });
  });

  it("refuses a pool node it cannot read", async () => {
    const { t } = tracker(() => ({
      issues: page([
        poolNode("ENG-1", { state: { name: "Backlog", type: "backlog" } }),
      ]),
    }));
    await expect(t.openIssues({ withSomeOf: [["xs"]] })).rejects.toThrow(
      "state.id",
    );
  });

  it("reads an issue's open children across pages", async () => {
    const { t, calls } = tracker((_call, n) => ({
      issue: {
        children:
          n === 0 ? page([poolNode("ENG-2")], "c1") : page([poolNode("ENG-3")]),
      },
    }));
    const got = await t.openChildren("ENG-1");
    expect(got.map((i) => i.identifier)).toEqual(["ENG-2", "ENG-3"]);
    expect(calls[0]?.variables.filter).toEqual({
      and: [
        { team: { key: { eq: "ENG" } } },
        { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
      ],
    });
    expect(calls[1]?.variables.after).toBe("c1");
  });

  it("refuses the children of another team's issue", async () => {
    const { t, calls } = tracker(() => ({ issue: { children: page([]) } }));
    await expect(t.openChildren("OPS-1")).rejects.toThrow("not a ENG issue");
    expect(calls).toHaveLength(0);
  });

  it("refuses an unreadable children page or an out-of-range priority", async () => {
    for (const extra of [
      { children: { pageInfo: {}, nodes: [] } },
      { priority: -1 },
      { priority: 1.5 },
      { priority: 5 },
    ]) {
      const { t } = tracker(() => ({
        issues: page([poolNode("ENG-1", extra)]),
      }));
      await expect(t.openIssues({ withSomeOf: [["xs"]] })).rejects.toThrow(
        "pool issue ENG-1",
      );
    }
  });

  it("reads one issue in pool form and reports a missing one as null", async () => {
    const found = tracker(() => ({
      issue: poolNode("ENG-9", {
        state: { id: "s-d", name: "Done", type: "completed" },
      }),
    }));
    expect((await found.t.poolIssue("ENG-9"))?.state.type).toBe("completed");
    const missing = tracker(
      () => new LinearApiError("Entity not found", 200, true),
    );
    expect(await missing.t.poolIssue("ENG-404")).toBeNull();
    const empty = tracker(() => ({ issue: null }));
    expect(await empty.t.poolIssue("ENG-404")).toBeNull();
    const omitted = tracker(() => ({}));
    await expect(omitted.t.poolIssue("ENG-9")).rejects.toThrow(
      "expected an object",
    );
  });
});

describe("Linear adapter: filing and planning", () => {
  const label = (
    id: string,
    name: string,
    group: string | null = null,
    isGroup = false,
  ) => ({ id, name, isGroup, parent: group === null ? null : { name: group } });
  const LABELS = [
    label("l-bug", "bug"),
    label("l-size", "size", null, true),
    label("l-xs", "xs", "size"),
    label("l-docs", "area:docs"),
    label("l-dup-1", "twice"),
    label("l-dup-2", "twice"),
  ];
  const issueId = (key: string) => ({
    issue: { id: `uuid-${key}`, team: { id: "team-1", key: "ENG" } },
  });

  /** The answer to each lookup the filing operations make, by operation. */
  const ANSWERS: Array<[string, (call: Call) => unknown]> = [
    ["TrackerTeam(", () => ({ teams: page([{ id: "team-1", key: "ENG" }]) })],
    ["TrackerLabels(", () => ({ issueLabels: page(LABELS) })],
    [
      "TrackerProject(",
      () => ({ projects: page([{ id: "p-1", name: "Debt" }]) }),
    ],
    ["TrackerIssueId(", (call) => issueId(String(call.variables.id))],
    [
      "TrackerCreate(",
      () => ({
        issueCreate: {
          success: true,
          issue: {
            identifier: "ENG-10",
            url: "https://tracker.example/ENG-10",
          },
        },
      }),
    ],
    ["TrackerUpdate(", () => ({ issueUpdate: { success: true } })],
    ["TrackerRelate(", () => ({ issueRelationCreate: { success: true } })],
  ];

  /** A tracker answering every lookup, `over` first where it answers. */
  function filing(over: (call: Call) => unknown = () => undefined) {
    return tracker((call) => {
      const own = over(call);
      if (own !== undefined) return own;
      const answer = ANSWERS.find(([op]) => call.query.includes(op));
      if (answer === undefined)
        throw new Error(`unexpected request: ${call.query.slice(0, 60)}`);
      return answer[1](call);
    });
  }

  it("lists the labels issues can carry, with their group, without group labels", async () => {
    const { t, calls } = filing();
    expect(await t.listLabels()).toEqual([
      { name: "area:docs", group: null },
      { name: "bug", group: null },
      { name: "twice", group: null },
      { name: "twice", group: null },
      { name: "xs", group: "size" },
    ]);
    expect(calls[0]?.variables.filter).toEqual({
      or: [{ team: { key: { eq: "ENG" } } }, { team: { null: true } }],
    });
  });

  it("refuses a label page it cannot read in full", async () => {
    const { t } = filing((call) =>
      call.query.includes("TrackerLabels(")
        ? { issueLabels: { pageInfo: { hasNextPage: true }, nodes: LABELS } }
        : undefined,
    );
    await expect(t.listLabels()).rejects.toThrow("cursor");
    const malformed = filing((call) =>
      call.query.includes("TrackerLabels(")
        ? { issueLabels: page([{ id: "l", name: "x" }]) }
        : undefined,
    );
    await expect(malformed.t.listLabels()).rejects.toThrow("isGroup");
  });

  it("files an issue with every name resolved to an id", async () => {
    const { t, calls } = filing();
    const created = await t.createIssue({
      title: "Fix it",
      description: "Body",
      labels: ["bug", "xs"],
      priority: 2,
      parent: "ENG-1",
      project: "Debt",
    });
    expect(created).toEqual({
      identifier: "ENG-10",
      url: "https://tracker.example/ENG-10",
    });
    expect(calls.at(-1)?.variables).toEqual({
      input: {
        teamId: "team-1",
        title: "Fix it",
        description: "Body",
        labelIds: ["l-bug", "l-xs"],
        priority: 2,
        parentId: "uuid-ENG-1",
        projectId: "p-1",
      },
    });
  });

  it("names every label that resolves to none or several, and writes nothing", async () => {
    const { t, calls } = filing();
    await expect(
      t.createIssue({
        title: "x",
        description: "",
        labels: ["bug", "nope", "twice", "size"],
      }),
    ).rejects.toThrow(
      "'nope' matches no label; 'twice' matches 2 labels; 'size' matches no label",
    );
    expect(calls.some((c) => c.query.includes("TrackerCreate("))).toBe(false);
  });

  it("refuses a priority off the scale before any request", async () => {
    for (const priority of [-1, 5, 1.5, Number.NaN]) {
      const { t, calls } = filing();
      await expect(
        t.createIssue({ title: "x", description: "", labels: [], priority }),
      ).rejects.toThrow("priority must be an integer");
      await expect(t.updateIssue("ENG-1", { priority })).rejects.toThrow(
        "priority must be an integer",
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a project that does not resolve to exactly one", async () => {
    const { t, calls } = filing((call) =>
      call.query.includes("TrackerProject(")
        ? {
            projects: page([
              { id: "p-1", name: "Debt" },
              { id: "p-2", name: "Debt" },
            ]),
          }
        : undefined,
    );
    await expect(
      t.createIssue({
        title: "x",
        description: "",
        labels: [],
        project: "Debt",
      }),
    ).rejects.toThrow("project 'Debt' matched 2");
    expect(calls.some((c) => c.query.includes("TrackerCreate("))).toBe(false);
  });

  it("refuses a filing the tracker did not accept", async () => {
    const { t } = filing((call) =>
      call.query.includes("TrackerCreate(")
        ? { issueCreate: { success: false, issue: null } }
        : undefined,
    );
    await expect(
      t.createIssue({ title: "x", description: "", labels: [] }),
    ).rejects.toThrow("did not succeed");
  });

  it("adds and removes labels by id, without reading or rewriting the issue's set", async () => {
    const { t, calls } = filing();
    await t.updateIssue("ENG-1", {
      addLabels: ["xs", "bug"],
      removeLabels: ["area:docs"],
      title: "New",
      parent: null,
    });
    expect(calls.at(-1)?.variables).toEqual({
      id: "uuid-ENG-1",
      input: {
        title: "New",
        parentId: null,
        addedLabelIds: ["l-xs", "l-bug"],
        removedLabelIds: ["l-docs"],
      },
    });
    await t.updateIssue("ENG-1", { removeLabels: ["bug"] });
    expect(calls.at(-1)?.variables).toEqual({
      id: "uuid-ENG-1",
      input: { removedLabelIds: ["l-bug"] },
    });
    const ops = calls.map((c) => /(?:query|mutation) (\w+)/.exec(c.query)?.[1]);
    expect(new Set(ops)).toEqual(
      new Set(["TrackerLabels", "TrackerIssueId", "TrackerUpdate"]),
    );
  });

  it("updates the other fields without reading labels", async () => {
    const { t, calls } = filing();
    await t.updateIssue("ENG-1", { project: "Debt", priority: 0 });
    expect(calls.some((c) => c.query.includes("TrackerLabels("))).toBe(false);
    expect(calls.at(-1)?.variables).toEqual({
      id: "uuid-ENG-1",
      input: { priority: 0, projectId: "p-1" },
    });
  });

  it("refuses an empty patch and a label both added and removed", async () => {
    const { t, calls } = filing();
    await expect(t.updateIssue("ENG-1", {})).rejects.toThrow("changes nothing");
    await expect(
      t.updateIssue("ENG-1", { addLabels: [], removeLabels: [] }),
    ).rejects.toThrow("changes nothing");
    await expect(
      t.updateIssue("ENG-1", { addLabels: ["bug"], removeLabels: ["bug"] }),
    ).rejects.toThrow("both adds and removes 'bug'");
    expect(calls).toHaveLength(0);
  });

  it("refuses an update the tracker did not accept", async () => {
    const { t } = filing((call) =>
      call.query.includes("TrackerUpdate(")
        ? { issueUpdate: { success: false } }
        : undefined,
    );
    await expect(t.updateIssue("ENG-1", { title: "x" })).rejects.toThrow(
      "did not succeed",
    );
  });

  it("searches this team's open issues by title or description", async () => {
    const summary = {
      identifier: "ENG-3",
      title: "Flaky login",
      state: { name: "Todo", type: "unstarted" },
      labels: labels("bug"),
    };
    const { t, calls } = tracker((_c, n) => ({
      issues: n === 0 ? page([summary], "c1") : page([]),
    }));
    expect(await t.searchIssues("login")).toEqual([
      {
        identifier: "ENG-3",
        title: "Flaky login",
        state: { name: "Todo", type: "unstarted" },
        labels: ["bug"],
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.variables.filter).toEqual({
      and: [
        { team: { key: { eq: "ENG" } } },
        {
          or: [
            { title: { containsIgnoreCase: "login" } },
            { description: { containsIgnoreCase: "login" } },
          ],
        },
        { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
      ],
    });
    expect(calls[0]?.variables.includeArchived).toBe(false);
    await t.searchIssues("login", { includeClosed: true });
    const closed = calls.at(-1)?.variables.filter as { and: unknown[] };
    expect(closed.and).toHaveLength(2);
    // The tracker archives completed issues; a closed search reads them too.
    expect(calls.at(-1)?.variables.includeArchived).toBe(true);
  });

  it("refuses an empty search and a truncated label list on a hit", async () => {
    const { t, calls } = tracker(() => ({ issues: page([]) }));
    await expect(t.searchIssues("  ")).rejects.toThrow("non-empty text");
    expect(calls).toHaveLength(0);
    const truncated = tracker(() => ({
      issues: page([
        {
          identifier: "ENG-3",
          title: "x",
          state: { name: "Todo", type: "unstarted" },
          labels: { pageInfo: { hasNextPage: true }, nodes: [] },
        },
      ]),
    }));
    await expect(truncated.t.searchIssues("x")).rejects.toThrow("truncated");
  });

  it("lists relations in both directions", async () => {
    const { t, calls } = tracker((call) =>
      call.query.includes("TrackerRelations(")
        ? {
            issue: {
              relations: page([
                {
                  id: "r1",
                  type: "blocks",
                  relatedIssue: { identifier: "ENG-2" },
                },
                {
                  id: "r2",
                  type: "related",
                  relatedIssue: { identifier: "ENG-3" },
                },
                {
                  id: "r3",
                  type: "similar",
                  relatedIssue: { identifier: "ENG-9" },
                },
                {
                  id: "r6",
                  type: "duplicate",
                  relatedIssue: { identifier: "ENG-6" },
                },
              ]),
            },
          }
        : {
            issue: {
              inverseRelations: page([
                { id: "r4", type: "blocks", issue: { identifier: "ENG-4" } },
                { id: "r5", type: "duplicate", issue: { identifier: "ENG-5" } },
              ]),
            },
          },
    );
    expect(await t.listRelations("ENG-1")).toEqual([
      { type: "blocks", issue: "ENG-2" },
      { type: "related", issue: "ENG-3" },
      { type: "duplicate", issue: "ENG-6" },
      { type: "blocked_by", issue: "ENG-4" },
      { type: "duplicated_by", issue: "ENG-5" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("fails a relation read on an unknown type or an incomplete page", async () => {
    const unknown = tracker(() => ({
      issue: {
        relations: page([
          { id: "r1", type: "causes", relatedIssue: { identifier: "ENG-2" } },
        ]),
      },
    }));
    await expect(unknown.t.listRelations("ENG-1")).rejects.toThrow(
      "unknown relation type 'causes'",
    );
    const partial = tracker(() => ({
      issue: {
        relations: { pageInfo: { hasNextPage: true }, nodes: [] },
      },
    }));
    await expect(partial.t.listRelations("ENG-1")).rejects.toThrow("cursor");
  });

  it("relates two issues by their tracker ids", async () => {
    const { t, calls } = filing();
    await t.relate("ENG-1", "blocks", "ENG-2");
    expect(calls.at(-1)?.variables).toEqual({
      input: {
        issueId: "uuid-ENG-1",
        relatedIssueId: "uuid-ENG-2",
        type: "blocks",
      },
    });
  });

  it("records a duplicate with the duplicate as the issue and the original as the related issue", async () => {
    const { t, calls } = filing();
    await t.relate("ENG-7", "duplicate", "ENG-2");
    expect(calls.at(-1)?.variables).toEqual({
      input: {
        issueId: "uuid-ENG-7",
        relatedIssueId: "uuid-ENG-2",
        type: "duplicate",
      },
    });
  });

  it("refuses a relation to itself, an unknown type, and one not accepted", async () => {
    const { t, calls } = filing();
    await expect(t.relate("ENG-1", "blocks", "ENG-1")).rejects.toThrow(
      "itself",
    );
    await expect(
      t.relate("ENG-1", "causes" as "blocks", "ENG-2"),
    ).rejects.toThrow("not a relation type");
    expect(calls).toHaveLength(0);
    const refused = filing((call) =>
      call.query.includes("TrackerRelate(")
        ? { issueRelationCreate: { success: false } }
        : undefined,
    );
    await expect(refused.t.relate("ENG-1", "related", "ENG-2")).rejects.toThrow(
      "did not succeed",
    );
  });
});

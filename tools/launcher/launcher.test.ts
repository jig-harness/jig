/**
 * The launcher with Linear replaced by a fake `fetch` and the workspace
 * provider by a recorder: nothing here reaches the network or opens an app.
 * One test runs the real entry point as a child process to prove it starts
 * with only the environment a tracker's GUI process has.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { parseConfig } from "./config.ts";
import { type ContextCache, cachePath } from "./cache.ts";
import { type LaunchDeps, launch } from "./launch.ts";
import type { OpenRequest, Provider } from "./provider.ts";
import { openRequest } from "./test-request.ts";
import {
  conductorProvider,
  deepLink,
  encodeComponent,
  lookupRepoRoot,
} from "./providers/conductor.ts";
import { getProvider } from "./providers/index.ts";
import { linearTracker, MAX_PAGES_PER_CONNECTION } from "./trackers/linear.ts";

type Json = Record<string, unknown>;

interface Request {
  query: string;
  variables: Json;
}

interface Scenario {
  assignee?: string | null;
  labels?: Array<{ name: string; parent?: string }>;
  comments?: Json[];
  commentPages?: Json[][];
  children?: Json[];
  relations?: Json[];
  inverseRelations?: Json[];
  /** Follow-up pages of labels; the first page is `labels`. */
  labelPages?: Json[][];
  /** GraphQL errors served with every follow-up page of labels. */
  labelPageErrors?: unknown[];
  /** Follow-up pages of relations; the first page is `relations`. */
  relationPages?: Json[][];
  /** GraphQL errors served with every follow-up page of relations. */
  relationPageErrors?: unknown[];
  mutation?: Json;
  readErrors?: unknown[];
  /** Replace the first-page issue wholesale. */
  issue?: unknown;
  /** Make a follow-up page for `comments` repeat this cursor. */
  loopCursor?: boolean;
  /** Advance the fake clock by this much when a follow-up page is served. */
  skewOnPage?: number;
  /** Never answer this request; only its abort signal ends it. */
  hang?: "read" | "assign";
}

const comment = (body: string, extra: Json = {}): Json => ({
  body,
  user: { id: "author" },
  createdAt: "2026-01-01T00:00:00Z",
  ...extra,
});

function connection(nodes: Json[], next?: string): Json {
  return {
    nodes,
    pageInfo: next
      ? { hasNextPage: true, endCursor: next }
      : { hasNextPage: false },
  };
}

const labelNode = (l: { name: string; parent?: string }): Json => ({
  name: l.name,
  parent: l.parent ? { name: l.parent } : null,
});

/** The follow-up page named by the cursor `<prefix>-<index>`. */
function numberedPage(prefix: string, after: unknown, pages: Json[][]): Json {
  const index = Number(String(after).replace(`${prefix}-`, ""));
  return connection(
    pages[index] ?? [],
    index + 1 < pages.length ? `${prefix}-${index + 1}` : undefined,
  );
}

function withErrors(data: unknown, errors: unknown): Json {
  return { data, ...(errors ? { errors } : {}) };
}

/** The body of a follow-up page request; `skew` is advanced for a comments page. */
function followUpBody(
  scenario: Scenario,
  query: string,
  after: unknown,
  advance: () => void,
): Json {
  if (query.includes("labels("))
    return withErrors(
      {
        issue: {
          labels: numberedPage("labels", after, scenario.labelPages ?? []),
        },
      },
      scenario.labelPageErrors,
    );
  if (query.includes("relations("))
    return withErrors(
      {
        issue: {
          relations: numberedPage(
            "relations",
            after,
            scenario.relationPages ?? [],
          ),
        },
      },
      scenario.relationPageErrors,
    );
  advance();
  const comments = scenario.loopCursor
    ? connection([comment("again")], String(after))
    : numberedPage("cursor", after, scenario.commentPages ?? []);
  return { data: { issue: { comments } } };
}

/** The issue as the scenario describes it, when it does not replace it wholesale. */
function scenarioIssue(scenario: Scenario): Json {
  const labelPages = scenario.labelPages ?? [];
  const relationPages = scenario.relationPages ?? [];
  const hasCommentPages =
    (scenario.commentPages ?? []).length > 0 || scenario.loopCursor;
  return {
    identifier: "ENG-1",
    title: "Launcher test",
    branchName: "eng-1-launcher-test",
    description: "Body",
    assignee: scenario.assignee ? { id: scenario.assignee } : null,
    labels: connection(
      (scenario.labels ?? []).map(labelNode),
      labelPages.length > 0 ? "labels-0" : undefined,
    ),
    comments: connection(
      scenario.comments ?? [],
      hasCommentPages ? "cursor-0" : undefined,
    ),
    children: connection(scenario.children ?? []),
    relations: connection(
      scenario.relations ?? [],
      relationPages.length > 0 ? "relations-0" : undefined,
    ),
    inverseRelations: connection(scenario.inverseRelations ?? []),
  };
}

/** The body of the first request: the viewer and the issue. */
function firstPageBody(scenario: Scenario): Json {
  return withErrors(
    {
      viewer: { id: "opening-user" },
      issue: scenario.issue ?? scenarioIssue(scenario),
    },
    scenario.readErrors,
  );
}

function harness(scenario: Scenario = {}) {
  const home = mkdtempSync(join(tmpdir(), "launcher-"));
  const requests: Request[] = [];
  const opened: OpenRequest[] = [];
  const warnings: string[] = [];
  let skew = 0;
  const fetchImpl = (async (
    _url: unknown,
    init: { body: string; signal: AbortSignal },
  ) => {
    const { query, variables } = JSON.parse(init.body) as Request;
    requests.push({ query, variables });
    const isAssign = query.includes("issueUpdate");
    if (scenario.hang === (isAssign ? "assign" : "read"))
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      );
    let body: unknown;
    if (isAssign)
      body = scenario.mutation ?? { data: { issueUpdate: { success: true } } };
    else if ("after" in variables)
      body = followUpBody(scenario, query, variables.after, () => {
        skew += scenario.skewOnPage ?? 0;
      });
    else body = firstPageBody(scenario);
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  const provider: Provider = {
    name: "conductor",
    validateRepo() {
      // any settings are valid
    },
    async open(request) {
      opened.push(request);
    },
  };
  const deps = (env: Json = {}): LaunchDeps => {
    const merged = { LINEAR_API_KEY: "fake-key", ...env } as LaunchDeps["env"];
    return {
      home,
      env: merged,
      tracker: linearTracker(
        { home, env: merged },
        { fetchImpl, now: () => 1_000_000 + skew },
      ),
      provider,
      nowSeconds: () => 1_700_000_000,
      warn: (m) => warnings.push(m),
    };
  };
  const cache = () =>
    JSON.parse(readFileSync(cachePath(home, "ENG-1"), "utf8")) as ContextCache;
  return { home, requests, opened, warnings, deps, cache };
}

function withConfig(home: string, yaml: string) {
  mkdirSync(join(home, ".linear"), { recursive: true });
  writeFileSync(join(home, ".linear", "launcher.yaml"), yaml);
}

async function run(
  scenario: Scenario,
  env: Json = {},
  yaml?: string,
  budgets: Partial<LaunchDeps> = {},
) {
  const h = harness(scenario);
  try {
    if (yaml) withConfig(h.home, yaml);
    await launch("ENG-1", "eng-1-branch", { ...h.deps(env), ...budgets });
    return {
      requests: h.requests,
      opened: h.opened,
      warnings: h.warnings,
      cache: existsSync(cachePath(h.home, "ENG-1")) ? h.cache() : null,
      home: h.home,
    };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

for (const assignee of [null, "another-user"]) {
  test(`assigns ${assignee ? "an issue owned by someone else" : "an unassigned issue"} to the authenticated user`, async () => {
    const r = await run({ assignee });
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1]?.query).toContain("issueUpdate");
    expect(r.requests[1]?.variables).toEqual({
      id: "ENG-1",
      assigneeId: "opening-user",
    });
    expect(r.warnings).toEqual([]);
    expect(r.opened).toHaveLength(1);
  });
}

test("does not mutate an issue already assigned to the authenticated user", async () => {
  const r = await run({ assignee: "opening-user" });
  expect(r.requests).toHaveLength(1);
  expect(r.opened).toHaveLength(1);
});

test("assigns only after pagination finishes, so assignment never spends the fetch budget", async () => {
  const r = await run({
    comments: [comment("first")],
    commentPages: [[comment("second")]],
  });
  expect(r.requests).toHaveLength(3);
  expect(r.requests[1]?.variables).toMatchObject({ after: "cursor-0" });
  expect(r.requests[2]?.query).toContain("issueUpdate");
  expect(r.cache?.comments?.map((c) => c.body)).toEqual(["first", "second"]);
});

test("assignment keeps its own budget after pagination exhausts the fetch deadline", async () => {
  const r = await run({
    comments: [comment("first")],
    commentPages: [[comment("second")]],
    skewOnPage: 3_600_000,
  });
  expect(r.requests.at(-1)?.query).toContain("issueUpdate");
  expect(r.warnings).toEqual([]);
  expect(r.cache?.comments).toHaveLength(2);
});

test("a read past the fetch deadline omits the unread connection but still opens", async () => {
  const r = await run({
    comments: [comment("first")],
    commentPages: [[comment("second")], [comment("third")]],
    skewOnPage: 3_600_000,
  });
  expect(r.cache?.comments).toBeUndefined();
  expect(r.warnings.join("\n")).toContain("comments incomplete");
  expect(r.opened).toHaveLength(1);
});

for (const mutation of [
  { data: { issueUpdate: { success: false } } },
  { data: { issueUpdate: null }, errors: [{ message: "Permission denied" }] },
]) {
  test(`still caches and opens when assignment fails: ${JSON.stringify(mutation)}`, async () => {
    const r = await run({ mutation });
    expect(r.warnings.join("\n")).toContain("Could not assign ENG-1");
    expect(r.cache?.comments).toEqual([]);
    expect(r.opened).toHaveLength(1);
  });
}

test("keeps usable issue data when a read response also carries GraphQL errors", async () => {
  const r = await run({
    readErrors: [{ message: "comment user unavailable" }],
  });
  expect(r.requests).toHaveLength(2);
  expect(r.cache?.comments).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("without an API key it seeds the description and opens an unrouted workspace", async () => {
  const r = await run(
    {},
    { LINEAR_API_KEY: "", LINEAR_PROMPT: "Fallback description" },
  );
  expect(r.requests).toEqual([]);
  expect(r.warnings.join("\n")).toContain("No Linear API key");
  expect(r.cache?.description).toBe("Fallback description");
  expect(r.cache?.comments).toBeUndefined();
  expect(r.opened[0]?.repo).toBeNull();
});

test("an unreadable issue degrades to the fallback instead of failing the launch", async () => {
  const r = await run({ issue: [] }, { LINEAR_PROMPT: "Fallback description" });
  expect(r.warnings.join("\n")).toContain("Could not fetch ENG-1");
  expect(r.cache?.description).toBe("Fallback description");
  expect(r.opened).toHaveLength(1);
});

test("the cache carries what the issue-pickup skill reads", async () => {
  const r = await run({
    comments: [comment("a"), { body: "b", user: null }],
    children: [{ identifier: "ENG-2" }],
    relations: [
      { relatedIssue: { identifier: "ENG-3" } },
      { relatedIssue: null },
    ],
  });
  expect(r.cache).toEqual({
    identifier: "ENG-1",
    title: "Launcher test",
    description: "Body",
    branch_name: "eng-1-launcher-test",
    cached_at: 1_700_000_000,
    comments: [
      { body: "a", author_id: "author", created_at: "2026-01-01T00:00:00Z" },
      { body: "b", author_id: null },
    ],
    comments_cached: true,
    sub_issue_ids: ["ENG-2"],
    linked_issue_ids: ["ENG-3"],
  });
});

test("the cache is private to the user", async () => {
  const h = harness();
  try {
    await launch("ENG-1", "", h.deps());
    const path = cachePath(h.home, "ENG-1");
    chmodSync(path, 0o644);
    await launch("ENG-1", "", h.deps());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("a looping cursor ends the connection as incomplete without duplicating pages", async () => {
  const r = await run({ comments: [comment("first")], loopCursor: true });
  expect(r.cache?.comments).toBeUndefined();
  expect(r.cache?.sub_issue_ids).toEqual([]);
  expect(r.warnings.join("\n")).toContain("comments incomplete");
});

test("a connection past the page ceiling is incomplete", async () => {
  const pages = Array.from({ length: MAX_PAGES_PER_CONNECTION + 2 }, (_, i) => [
    comment(`c${i}`),
  ]);
  const r = await run({ comments: [comment("first")], commentPages: pages });
  expect(r.cache?.comments).toBeUndefined();
  expect(r.warnings.join("\n")).toContain("comments incomplete");
});

test("one malformed comment omits the whole comments field", async () => {
  const r = await run({ comments: [comment("ok"), { body: 7 }] });
  expect(r.cache?.comments).toBeUndefined();
  expect(r.warnings.join("\n")).toContain("comments incomplete");
});

test("a sub-issue node without an identifier omits sub_issue_ids", async () => {
  const r = await run({ children: [{ identifier: "ENG-2" }, { other: 1 }] });
  expect(r.cache?.sub_issue_ids).toBeUndefined();
  expect(r.warnings.join("\n")).toContain("children incomplete");
});

test("a sub-issue identifier that is not an issue key omits sub_issue_ids", async () => {
  for (const bad of ["", "../x"]) {
    const r = await run({
      children: [{ identifier: "ENG-2" }, { identifier: bad }],
    });
    expect(r.cache?.sub_issue_ids).toBeUndefined();
    expect(r.warnings.join("\n")).toContain("children incomplete");
  }
});

test("an issue whose description was removed is cached with an empty one, not the tracker's", async () => {
  const issue: Json = {
    identifier: "ENG-1",
    title: "Launcher test",
    branchName: "b",
    description: "",
    assignee: null,
    labels: connection([]),
    comments: connection([]),
    children: connection([]),
    relations: connection([]),
    inverseRelations: connection([]),
  };
  const r = await run({ issue }, { LINEAR_PROMPT: "Stale description" });
  expect(r.cache?.description).toBe("");
});

test("a node that is not an object keeps the valid links but not the children", async () => {
  const r = await run({
    children: [{ identifier: "ENG-2" }, null as unknown as Json],
    relations: [
      { relatedIssue: { identifier: "ENG-3" } },
      null as unknown as Json,
    ],
    inverseRelations: [
      7 as unknown as Json,
      { issue: { identifier: "ENG-4" } },
    ],
  });
  expect(r.cache?.linked_issue_ids).toEqual(["ENG-3", "ENG-4"]);
  expect(r.cache?.sub_issue_ids).toBeUndefined();
  const warnings = r.warnings.join("\n");
  expect(warnings).toContain("children incomplete");
  expect(warnings).toContain("relations incomplete");
  expect(warnings).toContain("inverseRelations incomplete");
});

test("a linked identifier that is not an issue key is dropped and marks the links incomplete", async () => {
  for (const bad of ["", "../x", 7]) {
    const r = await run({
      relations: [
        { relatedIssue: { identifier: "ENG-3" } },
        { relatedIssue: { identifier: bad } },
      ],
      inverseRelations: [
        { issue: { identifier: bad } },
        { issue: { identifier: "ENG-4" } },
      ],
    });
    expect(r.cache?.linked_issue_ids).toEqual(["ENG-3", "ENG-4"]);
    const warnings = r.warnings.join("\n");
    expect(warnings).toContain("relations incomplete");
    expect(warnings).toContain("inverseRelations incomplete");
  }
});

test("a malformed node on a later page does not stop the pages after it", async () => {
  const r = await run({
    relations: [{ relatedIssue: { identifier: "ENG-2" } }],
    relationPages: [
      [{ relatedIssue: { identifier: "ENG-3" } }, null as unknown as Json],
      [{ relatedIssue: { identifier: "ENG-4" } }],
    ],
  });
  expect(r.cache?.linked_issue_ids).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
  expect(r.warnings.join("\n")).toContain("relations incomplete");
});

test("a field error on a later page of links keeps that page's readable links", async () => {
  const r = await run({
    relations: [{ relatedIssue: { identifier: "ENG-2" } }],
    relationPages: [
      [{ relatedIssue: { identifier: "ENG-3" } }, { relatedIssue: null }],
    ],
    relationPageErrors: [
      { message: "boom", path: ["issue", "relations", "nodes", 1] },
    ],
  });
  expect(r.cache?.linked_issue_ids).toEqual(["ENG-2", "ENG-3"]);
  expect(r.warnings.join("\n")).toContain("relations incomplete");
});

test("never replaces an existing cache with the fallback", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.home, ".cache", "conductor-linear"), { recursive: true });
    writeFileSync(
      cachePath(h.home, "ENG-1"),
      JSON.stringify({ title: "Kept", description: "rich" }),
    );
    await launch(
      "ENG-1",
      "",
      h.deps({ LINEAR_API_KEY: "", LINEAR_PROMPT: "thin" }),
    );
    expect(h.cache().description).toBe("rich");
    expect(h.opened[0]?.prompt).toContain("ENG-1 — Kept");
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("an existing cache that cannot be read still opens the issue, untitled", async () => {
  const h = harness();
  try {
    mkdirSync(cachePath(h.home, "ENG-1"), { recursive: true });
    await launch(
      "ENG-1",
      "",
      h.deps({ LINEAR_API_KEY: "", LINEAR_PROMPT: "thin" }),
    );
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.prompt).toContain("Launcher context:");
    expect(h.warnings.join("\n")).toContain(
      "Could not read the context cache for the title",
    );
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

const ROUTING = `
repos:
  alpha:
    conductor: Alpha App
  beta:
    herdr: {host: box}
`;

test("routes by the label in the configured group", async () => {
  const r = await run(
    {
      labels: [
        { name: "bug", parent: "Type" },
        { name: "alpha", parent: "Repo" },
      ],
    },
    {},
    ROUTING,
  );
  expect(r.opened[0]?.repo).toBe("Alpha App");
});

test("a label with no entry for the provider is unrouted", async () => {
  const r = await run(
    { labels: [{ name: "beta", parent: "Repo" }] },
    {},
    ROUTING,
  );
  expect(r.opened[0]?.repo).toBeNull();
});

test("a label outside the group, or a different group name, is ignored", async () => {
  const labels = [{ name: "alpha", parent: "Type" }];
  expect((await run({ labels }, {}, ROUTING)).opened[0]?.repo).toBeNull();
  const named = await run(
    { labels: [{ name: "alpha", parent: "Project" }] },
    {},
    `repo_label_group: Project${ROUTING}`,
  );
  expect(named.opened[0]?.repo).toBe("Alpha App");
});

test("a repository label past the first page still routes", async () => {
  const r = await run(
    {
      labels: [{ name: "bug", parent: "Type" }],
      labelPages: [
        [{ name: "alpha", parent: "Repo" }].map((l) => ({
          name: l.name,
          parent: { name: l.parent },
        })),
      ],
    },
    {},
    ROUTING,
  );
  expect(r.opened[0]?.repo).toBe("Alpha App");
  expect(r.warnings).toEqual([]);
});

test("a malformed label marks the labels incomplete instead of routing past it", async () => {
  const r = await run(
    {
      labels: [{ name: "bug", parent: "Type" }],
      labelPages: [
        [
          { name: 7, parent: { name: "Repo" } },
          { name: "alpha", parent: { name: "Repo" } },
        ],
      ],
    },
    {},
    ROUTING,
  );
  expect(r.opened[0]?.repo).toBeNull();
  expect(r.warnings.join("\n")).toContain("labels incomplete");
});

test("a repository label read before the labels went incomplete does not route", async () => {
  const malformed = await run(
    {
      labels: [{ name: "alpha", parent: "Repo" }],
      labelPages: [[{ name: 7, parent: { name: "Repo" } }]],
    },
    {},
    ROUTING,
  );
  expect(malformed.opened[0]?.repo).toBeNull();
  expect(malformed.warnings.join("\n")).toContain(
    "labels incomplete for ENG-1",
  );
  const errored = await run(
    {
      labels: [{ name: "alpha", parent: "Repo" }],
      labelPages: [[{ name: "beta", parent: { name: "Repo" } }]],
      labelPageErrors: [{ message: "denied", path: ["issue", "labels"] }],
    },
    {},
    ROUTING,
  );
  expect(errored.opened[0]?.repo).toBeNull();
  expect(errored.warnings.join("\n")).toContain("issue left unrouted");
});

test("a label whose parent has no readable name marks the labels incomplete", async () => {
  const r = await run(
    { labelPages: [[{ name: "alpha", parent: { name: 7 } }]] },
    {},
    ROUTING,
  );
  expect(r.warnings.join("\n")).toContain("labels incomplete");
});

test("a label without its parent field marks the labels incomplete", async () => {
  const r = await run(
    {
      labels: [{ name: "alpha", parent: "Repo" }],
      labelPages: [[{ name: "unknown" }]],
    },
    {},
    ROUTING,
  );
  expect(r.opened[0]?.repo).toBeNull();
  expect(r.warnings.join("\n")).toContain("labels incomplete");
});

test("a label named like an inherited property is unrouted, not a crash", async () => {
  const r = await run(
    { labels: [{ name: "constructor", parent: "Repo" }] },
    {},
    ROUTING,
  );
  expect(r.opened[0]?.repo).toBeNull();
});

test("the prompt starts with the skill and key, then names the context file", async () => {
  const r = await run({}, {}, "skill: /acme:start\n");
  const prompt = r.opened[0]?.prompt ?? "";
  expect(prompt.split("\n")[0]).toBe("/acme:start ENG-1");
  expect(prompt).toContain("ENG-1 — Launcher test");
  expect(prompt).toContain("Branch hint: eng-1-branch");
  expect(prompt).toContain(
    `Launcher context: ${join(r.home, ".cache", "conductor-linear", "ENG-1.json")}`,
  );
});

test("reads the API key from the private key file", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.home, ".linear"), { recursive: true });
    writeFileSync(join(h.home, ".linear", "api-key"), "file-key\n");
    await launch("ENG-1", "", h.deps({ LINEAR_API_KEY: "" }));
    expect(h.requests.length).toBeGreaterThan(0);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("incoming relations are linked too, each issue once", async () => {
  const r = await run({
    relations: [{ relatedIssue: { identifier: "ENG-3" } }],
    inverseRelations: [
      { issue: { identifier: "ENG-4" } },
      { issue: { identifier: "ENG-3" } },
      { issue: null },
    ],
  });
  expect(r.cache?.linked_issue_ids).toEqual(["ENG-3", "ENG-4"]);
});

test("comments are cached oldest first whatever order the API returns", async () => {
  const r = await run({
    comments: [
      comment("newer", { createdAt: "2026-02-01T00:00:00Z" }),
      comment("older", { createdAt: "2026-01-01T00:00:00Z" }),
    ],
  });
  expect(r.cache?.comments?.map((c) => c.body)).toEqual(["older", "newer"]);
});

test("a description Linear reports an error for is not cached as empty", async () => {
  const r = await run({
    issue: {
      identifier: "ENG-1",
      title: "Launcher test",
      branchName: "b",
      description: null,
      assignee: null,
      labels: connection([]),
      comments: connection([]),
      children: connection([]),
      relations: connection([]),
      inverseRelations: connection([]),
    },
    readErrors: [{ message: "boom", path: ["issue", "description"] }],
  });
  expect(r.cache).toBeNull();
  expect(r.warnings.join("\n")).toContain("description unreadable");
  expect(r.opened).toHaveLength(1);
});

for (const [what, description] of [
  ["missing", undefined],
  ["not text", 7],
] as const)
  test(`a description that comes back ${what} is not cached as empty`, async () => {
    const issue: Json = {
      identifier: "ENG-1",
      title: "Launcher test",
      branchName: "b",
      assignee: null,
      labels: connection([]),
      comments: connection([]),
      children: connection([]),
      relations: connection([]),
      inverseRelations: connection([]),
    };
    if (description !== undefined) issue.description = description;
    const r = await run({ issue });
    expect(r.cache).toBeNull();
    expect(r.warnings.join("\n")).toContain("description unreadable");
    // With the tracker's own description to stand in, the cache is written.
    const seeded = await run({ issue }, { LINEAR_PROMPT: "From the app" });
    expect(seeded.cache?.description).toBe("From the app");
  });

test("an issue with no description is cached with an empty one", async () => {
  const r = await run({
    issue: {
      identifier: "ENG-1",
      title: "Launcher test",
      branchName: "b",
      description: null,
      assignee: null,
      labels: connection([]),
      comments: connection([]),
      children: connection([]),
      relations: connection([]),
      inverseRelations: connection([]),
    },
  });
  expect(r.cache?.description).toBe("");
  expect(r.warnings.join("\n")).not.toContain("description unreadable");
});

test("a field error inside a connection marks it incomplete", async () => {
  const r = await run({
    comments: [comment("a")],
    readErrors: [{ message: "boom", path: ["issue", "comments", "nodes", 0] }],
  });
  expect(r.cache?.comments).toBeUndefined();
  expect(r.warnings.join("\n")).toContain("comments incomplete");
});

test("an issue key that could leave the cache directory is refused before anything runs", async () => {
  const h = harness();
  try {
    for (const key of ["../../target", "a/b", ".."])
      await expect(launch(key, "", h.deps())).rejects.toThrow(
        "is not an issue key",
      );
    expect(h.requests).toEqual([]);
    expect(h.opened).toEqual([]);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("the cache path itself refuses a key that is not one", () => {
  expect(() => cachePath("/home", "../x")).toThrow("is not an issue key");
  expect(cachePath("/home", "ENG-1")).toEndWith("ENG-1.json");
});

test("an unreadable key file only warns, and the workspace still opens", async () => {
  const h = harness();
  try {
    // A directory where the key file belongs makes the read throw.
    mkdirSync(join(h.home, ".linear", "api-key"), { recursive: true });
    await launch("ENG-1", "", h.deps({ LINEAR_API_KEY: "" }));
    expect(h.warnings.join("\n")).toContain(
      "Could not read the Linear API key",
    );
    expect(h.opened).toHaveLength(1);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("a tracker read that never answers is abandoned at the deadline, and the workspace still opens", async () => {
  const r = await run({ hang: "read" }, {}, undefined, { readBudgetMs: 20 });
  expect(r.warnings.join("\n")).toContain("Could not fetch ENG-1");
  expect(r.opened).toHaveLength(1);
});

test("an assignment that never answers is abandoned at the deadline, and the cache is still written", async () => {
  const r = await run({ hang: "assign" }, {}, undefined, {
    assignBudgetMs: 20,
  });
  expect(r.warnings.join("\n")).toContain("Could not assign ENG-1");
  expect(r.cache?.title).toBe("Launcher test");
  expect(r.opened).toHaveLength(1);
});

test("the provider is handed a deadline", async () => {
  const r = await run({});
  expect(r.opened[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(r.opened[0]?.signal.aborted).toBe(false);
});

test("an inherited property name is not a provider", () => {
  expect(() => getProvider("constructor")).toThrow(
    'unknown provider "constructor"',
  );
});

// ── configuration ──────────────────────────────────────────────────────────

test("configuration defaults apply to an empty file", () => {
  expect(parseConfig("", "c.yaml")).toEqual({
    tracker: "linear",
    provider: "conductor",
    skill: "/jig:do-item",
    repoLabelGroup: "Repo",
    repos: {},
  });
});

test("a repository label named like an object property is an ordinary label", () => {
  const { repos } = parseConfig(
    "repos:\n  __proto__:\n    conductor: a\n  constructor:\n    conductor: b\n",
    "c.yaml",
  );
  expect(Object.keys(repos)).toEqual(["__proto__", "constructor"]);
  expect(Object.getOwnPropertyDescriptor(repos, "__proto__")?.value).toEqual({
    conductor: "a",
  });
  expect(repos.toString).toBeUndefined();
});

test("a repository's settings can merge a shared mapping in", () => {
  const { repos } = parseConfig(
    "repos:\n  alpha: &a\n    conductor: Alpha\n  beta:\n    <<: *a\n    herdr: b\n",
    "c.yaml",
  );
  expect(repos.beta).toEqual({ conductor: "Alpha", herdr: "b" });
});

test("a date-like setting stays a string", () => {
  const { repos } = parseConfig(
    "repos:\n  alpha:\n    conductor: 2026-01-01\n",
    "c.yaml",
  );
  expect(repos.alpha).toEqual({ conductor: "2026-01-01" });
});

for (const [yaml, message] of [
  ["provid: x\n", "unknown key provid"],
  ["repos: [a]\n", "repos must be a mapping"],
  ["repos: 2026-01-01\n", "repos must be a mapping"],
  ["repos:\n  alpha: 2026-01-01\n", "repos.alpha must map a provider name"],
  ["2026-01-01\n", "expected a mapping"],
  ["repos:\n  a: b\n", "repos.a must map a provider name"],
  ["skill: do it\n", "skill must be one slash command"],
  ["provider: 3\n", "provider must be a non-empty string"],
] as const) {
  test(`configuration rejects ${message}`, () => {
    expect(() => parseConfig(yaml, "c.yaml")).toThrow(message);
  });
}

test("an unknown provider fails before anything is fetched", async () => {
  const h = harness();
  try {
    withConfig(h.home, "provider: nowhere\n");
    const { provider: _unused, ...deps } = h.deps();
    await expect(launch("ENG-1", "", deps)).rejects.toThrow(
      'unknown provider "nowhere"',
    );
    expect(h.requests).toEqual([]);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

// ── Conductor provider ─────────────────────────────────────────────────────

const request = (repo: unknown): OpenRequest =>
  openRequest(repo, "/s ENG-1\nBranch hint: a&b");

test("a routed repository is forced with prompt and path", () => {
  expect(deepLink(request("x"), "/Users/me/My Repo #1")).toBe(
    "conductor://prompt=%2Fs%20ENG-1%0ABranch%20hint%3A%20a%26b&path=%2FUsers%2Fme%2FMy%20Repo%20%231",
  );
});

test("an unrouted issue uses linear_id so Conductor detects the repository", () => {
  expect(deepLink(request(null), "")).toBe(
    "conductor://linear_id=ENG-1&prompt=%2Fs%20ENG-1%0ABranch%20hint%3A%20a%26b",
  );
});

test("every reserved mark is escaped, slashes included", () => {
  expect(encodeComponent("/a b/c(d)*'!")).toBe("%2Fa%20b%2Fc%28d%29%2A%27%21");
});

test("the provider resolves the repository root from Conductor's database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conductor-db-"));
  try {
    const dbPath = join(dir, "conductor.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE repos (name TEXT, root_path TEXT)");
    db.run("INSERT INTO repos VALUES ('Alpha App', '/work/alpha app')");
    db.close();
    expect(lookupRepoRoot(dbPath, "Alpha App")).toBe("/work/alpha app");
    expect(lookupRepoRoot(dbPath, "Missing")).toBe("");
    expect(lookupRepoRoot(join(dir, "absent.db"), "Alpha App")).toBe("");
    writeFileSync(join(dir, "broken.db"), "not a database");
    expect(lookupRepoRoot(join(dir, "broken.db"), "Alpha App")).toBe("");

    const urls: string[] = [];
    const provider = conductorProvider({
      repoRoot: (name) => lookupRepoRoot(dbPath, name),
      openUrl: async (url) => {
        urls.push(url);
      },
    });
    await provider.open(request("Alpha App"));
    await provider.open(request("Unknown"));
    expect(urls[0]).toContain("&path=%2Fwork%2Falpha%20app");
    expect(urls[1]).toStartWith("conductor://linear_id=ENG-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Conductor stops a stuck opener at the deadline", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const provider = conductorProvider({
    repoRoot: () => "",
    openUrl: (_url, signal) => {
      seen.push(signal);
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
  });
  const opening = provider.open({
    ...request(null),
    signal: controller.signal,
  });
  controller.abort();
  await expect(opening).rejects.toThrow("aborted");
  expect(seen[0]).toBe(controller.signal);
});

test("a repository entry must be a Conductor repository name", () => {
  const provider = conductorProvider();
  expect(() => provider.validateRepo({ a: 1 }, "alpha")).toThrow(
    "repos.alpha.conductor",
  );
  expect(() => provider.validateRepo("Alpha App", "alpha")).not.toThrow();
});

// ── the real entry point ───────────────────────────────────────────────────

test("starts with only a GUI process's environment and opens the deep link", () => {
  const home = mkdtempSync(join(tmpdir(), "launcher-e2e-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const fakeOpen = join(bin, "open");
    writeFileSync(
      fakeOpen,
      '#!/bin/sh\nprintf "%s\\n" "$1" > "$HOME/opened"\n',
    );
    chmodSync(fakeOpen, 0o755);
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dirname, "launch.ts"),
        "ENG-1",
        "eng-1-x",
      ],
      {
        // No shell profile, no LINEAR_API_KEY: only what the tracker provides.
        env: {
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          LINEAR_PROMPT: "From the tracker",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(result, 0, "launch.ts");
    const opened = readFileSync(join(home, "opened"), "utf8");
    expect(opened).toStartWith("conductor://linear_id=ENG-1&prompt=");
    expect(opened).toContain("%2Fjig%3Ado-item");
    const cache = JSON.parse(
      readFileSync(cachePath(home, "ENG-1"), "utf8"),
    ) as ContextCache;
    expect(cache.description).toBe("From the tracker");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

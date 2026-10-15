/**
 * `review.ts` over a store two repositories reflect into: what each review
 * sees, recording decisions, escalating, and reconciling approved fixes with
 * what merged.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  finding,
  Machine,
  type Repo,
  toolFinding,
} from "../../reflect/__tests__/scratch.ts";

interface Group {
  owner: string;
  class: string;
  target: string;
  count: number;
  findings: Array<{
    id: string;
    status: string;
    change: { repository: string };
  }>;
}

interface Loaded {
  repository: string;
  tools: string[];
  groups: Group[];
  awaiting_merge: Array<{ id: string }>;
  notices: unknown[];
}

let m: Machine;
beforeEach(() => {
  m = new Machine();
  m.userConfig();
});
afterEach(() => m.cleanup());

function load(repo: Repo, args: string[] = []): Loaded {
  const r = repo.review(["load", ...args]);
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Loaded;
}

function reflectInto(
  repo: Repo,
  ...findings: Array<Record<string, unknown>>
): string[] {
  const ids = findings.map((f) => repo.note(f));
  repo.json("reflect.ts", ["contribute"]);
  return ids;
}

/** A repository that is the `jig` tool: it holds the plugin's manifest. */
function jigRepository(): Repo {
  const repo = m.repository("jig", "git@github.com:example/jig.git");
  mkdirSync(join(repo.root, "plugin", ".claude-plugin"), { recursive: true });
  repo.commit("plugin", {
    "plugin/.claude-plugin/plugin.json": '{"name":"jig","version":"1.0.0"}\n',
  });
  return repo;
}

describe("two repositories reflecting into one store", () => {
  it("shows each review only its own findings, and the tool's repository the tool's findings from both", () => {
    const web = m.repository("web", "git@github.com:example/web.git");
    const api = m.repository("api", "https://github.com/example/api.git");
    const [webOwn, webTool] = reflectInto(web, finding(), toolFinding());
    const [apiOwn, apiTool] = reflectInto(
      api,
      finding({ title: "The api's own" }),
      toolFinding({ title: "Seen in api" }),
    );
    const jig = jigRepository();

    const ids = (loaded: Loaded) =>
      loaded.groups.flatMap((g) => g.findings.map((f) => f.id)).sort();
    expect(ids(load(web))).toEqual([webOwn as string]);
    expect(ids(load(api))).toEqual([apiOwn as string]);
    const jigView = load(jig);
    expect(jigView.tools).toEqual(["jig"]);
    expect(ids(jigView)).toEqual([webTool as string, apiTool as string].sort());
    expect(jigView.groups).toMatchObject([
      {
        owner: "tool:jig",
        class: "narrow-fix-per-round",
        target: "jig/drive-pr",
        count: 2,
      },
    ]);
  });

  it("narrows by class, target, severity and time", () => {
    const web = m.repository("web", "git@github.com:example/web.git");
    reflectInto(
      web,
      finding(),
      finding({
        class: "gate-missed-known-problem",
        severity: "high",
        target: { scope: "repository", name: "lefthook.yml" },
      }),
    );
    expect(
      load(web, ["--class", "gate-missed-known-problem"]).groups,
    ).toHaveLength(1);
    expect(load(web, ["--target", "AGENTS.md"]).groups).toHaveLength(1);
    expect(load(web, ["--severity", "high"]).groups[0]?.class).toBe(
      "gate-missed-known-problem",
    );
    expect(load(web, ["--since", "2999-01-01T00:00:00Z"]).groups).toEqual([]);
  });
});

describe("decisions", () => {
  it("records decisions about findings in the store, and refuses one about a finding it does not hold", () => {
    const web = m.repository("web", "git@github.com:example/web.git");
    const [a, b] = reflectInto(web, finding(), finding({ title: "Another" }));
    const ok = web.review(
      ["record", "--session", '{"model":"a-model"}'],
      `${JSON.stringify({ finding: a, decision: "dismissed", reason: "already fixed" })}\n${JSON.stringify({ finding: b, decision: "deferred", reason: "not now" })}\n`,
    );
    expect(ok.code).toBe(0);
    expect(load(web).groups).toEqual([]);
    const refused = web.review(
      ["record"],
      JSON.stringify({
        finding: "20261012T150405Z-0000000000000009",
        decision: "dismissed",
        reason: "x",
      }),
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("the store holds no finding");
    const noReason = web.review(
      ["record"],
      JSON.stringify({ finding: a, decision: "dismissed" }),
    );
    expect(noReason.code).toBe(2);
  });

  it("tells apart repositories with no remote that share a folder name", () => {
    const one = m.repository(join("one", "app"), null);
    const two = m.repository(join("two", "app"), null);
    reflectInto(one, finding());
    reflectInto(two, finding(), finding({ title: "Another" }));
    const mine = load(one);
    expect(mine.repository).toMatch(/^local\/app-[0-9a-f]{12}$/);
    expect(load(two).repository).not.toBe(mine.repository);
    expect(mine.groups.map((g) => g.count)).toEqual([1]);
  });

  it("refuses a decision or an escalation about another repository's findings", () => {
    const web = m.repository("web", "git@github.com:example/web.git");
    const api = m.repository("api", "git@github.com:example/api.git");
    const [theirs] = reflectInto(api, finding());
    const decided = web.review(
      ["record"],
      JSON.stringify({ finding: theirs, decision: "dismissed", reason: "x" }),
    );
    expect(decided.code).toBe(2);
    expect(decided.stderr).toContain("which this review does not act on");
    const escalated = web.review([
      "escalate",
      "instruction-missing-precondition",
      "ENG-77",
      "--owner",
      "repository:github.com/example/api",
    ]);
    expect(escalated.code).toBe(2);
    expect(escalated.stderr).toContain("is not an owner this review acts on");
    expect(load(api).groups.map((g) => g.count)).toEqual([1]);
  });

  it("plans escalation for a class at the threshold and escalates its open and deferred findings", () => {
    const web = m.repository("web", "git@github.com:example/web.git");
    const ids = reflectInto(
      web,
      finding(),
      finding({ title: "2" }),
      finding({ title: "3" }),
    );
    web.review(
      ["record"],
      JSON.stringify({
        finding: ids[2],
        decision: "deferred",
        reason: "later",
      }),
    );
    const plan = JSON.parse(web.review(["plan"]).stdout) as {
      classes: Array<{ class: string; count: number; action: string }>;
    };
    expect(plan.classes).toMatchObject([
      { class: "instruction-missing-precondition", count: 3, action: "file" },
    ]);
    const out = JSON.parse(
      web.review(["escalate", "instruction-missing-precondition", "ENG-77"])
        .stdout,
    ) as { escalated: string[] };
    expect(out.escalated.sort()).toEqual([...ids].sort() as string[]);
    expect(load(web).groups).toEqual([]);
  });
});

describe("reconcile", () => {
  function withOrigin(): { repo: Repo; base: string } {
    const bare = join(m.dir, "origin.git");
    const seed = m.repository("seed", null);
    seed.git("init", "-q", "--bare", bare);
    const repo = m.repository("web", bare);
    repo.git("push", "-q", "origin", "main");
    repo.git("remote", "set-head", "origin", "main");
    return { repo, base: bare };
  }

  it("records implemented once the approved commit is on the integration branch, and only then", () => {
    const { repo } = withOrigin();
    const [landed, pending] = reflectInto(
      repo,
      finding(),
      finding({ title: "Fix not merged yet" }),
    );
    const merged = repo.commit("fix: add the start command", {
      "AGENTS.md": "start the database first\n",
    });
    repo.git("push", "-q", "origin", "main");
    repo.git("checkout", "-q", "-b", "unmerged");
    const unmerged = repo.commit("fix: not merged", { "OTHER.md": "x\n" });
    repo.git("checkout", "-q", "main");
    repo.review(
      ["record"],
      `${JSON.stringify({ finding: landed, decision: "approved", reason: "add it", commit: merged })}\n${JSON.stringify({ finding: pending, decision: "approved", reason: "add it", commit: unmerged })}\n`,
    );

    const dry = JSON.parse(repo.review(["reconcile", "--dry-run"]).stdout) as {
      implemented: Array<{ finding: string }>;
    };
    expect(dry.implemented.map((i) => i.finding)).toEqual([landed as string]);
    expect(
      load(repo)
        .awaiting_merge.map((f) => f.id)
        .sort(),
    ).toEqual([landed, pending].sort() as string[]);

    const out = JSON.parse(repo.review(["reconcile"]).stdout) as {
      implemented: Array<{ finding: string; commit: string }>;
      still_approved: string[];
    };
    expect(out.implemented).toEqual([
      { finding: landed as string, commit: merged },
    ]);
    expect(out.still_approved).toEqual([pending as string]);
    expect(load(repo).awaiting_merge.map((f) => f.id)).toEqual([
      pending as string,
    ]);
  });

  it("reports a commit this clone does not have as unverifiable, never as unmerged", () => {
    const { repo } = withOrigin();
    const [id] = reflectInto(repo, finding());
    repo.review(
      ["record"],
      JSON.stringify({
        finding: id,
        decision: "approved",
        reason: "x",
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    );
    const out = JSON.parse(repo.review(["reconcile"]).stdout) as {
      unverifiable: Array<{ finding: string; reason: string }>;
    };
    expect(out.unverifiable).toMatchObject([{ finding: id }]);
    expect(load(repo).awaiting_merge.map((f) => f.id)).toEqual([id as string]);
  });

  it("stops without recording anything when the integration branch cannot be fetched", () => {
    const { repo, base } = withOrigin();
    const [id] = reflectInto(repo, finding());
    const head = repo.git("rev-parse", "HEAD").trim();
    repo.review(
      ["record"],
      JSON.stringify({
        finding: id,
        decision: "approved",
        reason: "x",
        commit: head,
      }),
    );
    // The remote's address, and so the repository's name, stays; it is gone.
    renameSync(base, `${base}.gone`);
    const r = repo.review(["reconcile"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("nothing was reconciled");
    expect(load(repo).awaiting_merge.map((f) => f.id)).toEqual([id as string]);
  });
});

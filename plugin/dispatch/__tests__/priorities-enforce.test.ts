/**
 * The host's `priorities.enforce` opt-in: off, the tick's pickups keep the
 * plan's order whatever the ranking says; on, they start in the ranking's
 * order, the design's sample week launch by launch, a weights file edited
 * between two ticks changes the next tick's first start, and no lane holds a
 * start back while ready work in another lane could take it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../shared/guarded-git-spawn.ts";
import { classify } from "../../shared/priorities/classify.ts";
import type { WeightedLane } from "../../shared/priorities/lanes.ts";
import { PRIORITIES_FILE } from "../../shared/priorities/record.ts";
import {
  type LaneEpochs,
  rank,
  readyLanes,
} from "../../shared/priorities/ranker.ts";
import type { SnapshotItem } from "../../shared/priorities/snapshot.ts";
import { closeWeek, type WeekCharge } from "../../shared/priorities/week.ts";
import { dump } from "../../shared/yaml.ts";
import type { QueueIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  input,
  item,
  objectiveWork,
} from "../../shared/__tests__/priorities-fixtures.ts";
import type { ItemClass } from "../lib/allocation-store.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { priorityLines } from "../lib/priorities-lines.ts";
import { enforcePickupOrder } from "../lib/priorities-order.ts";
import {
  preparePriorities,
  type PrioritiesReport,
  rankPriorities,
} from "../lib/tick-priorities.ts";
import type { Action, RepoReport, WantedItem } from "../lib/types.ts";
import { report } from "./line-fixtures.ts";

const SLUG = "example-org/web";
const NOW = Date.parse("2026-11-18T08:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-priorities-enforce-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, env: withoutLeakyGitEnv(process.env) },
  );
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
}

/** A checkout whose `origin/main` holds a record with one objective per class, each selecting a label. */
function checkout(): string {
  const dir = scratch();
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, ".config"));
  const objective = (id: string, cls: string) => ({
    id,
    class: cls,
    purpose: `the ${id} purpose`,
    endState: `the ${id} end state`,
    owner: "maintainers",
    epics: [{ scope: SLUG, labels: [id] }],
  });
  writeFileSync(
    join(dir, PRIORITIES_FILE),
    dump({
      level: "repository",
      scope: SLUG,
      revision: 1,
      objectives: [
        objective("core-goal", "core"),
        objective("tactical-goal", "tactical"),
        objective("peripheral-goal", "peripheral"),
      ],
    }),
  );
  git(dir, "add", PRIORITIES_FILE);
  git(dir, "commit", "-q", "-m", "record");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function queueIssue(key: string, label: string | null): QueueIssue {
  return {
    identifier: key,
    title: `item ${key}`,
    url: null,
    priority: 3,
    type: "Feature",
    size: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    assignee: { id: "u1", name: "factory-bot" },
    labels: label === null ? [] : [label],
    isEpic: false,
    hasOpenChildren: false,
    truncated: [],
    relations: [],
    parent: null,
  };
}

function wanted(key: string, label: string | null): WantedItem {
  return {
    key,
    title: `item ${key}`,
    url: null,
    state: "Todo",
    assignee: "factory-bot",
    assignedBy: "maintainer",
    queueIssue: queueIssue(key, label),
  };
}

function pickup(key: string): Action {
  return {
    stage: "pickup",
    target: key,
    record: "tracker",
    reason: "assigned",
    evidence: {},
  };
}

/** The tick's pickups, labelled into lanes, in the plan's order: unallocated first, so an enforced order differs from it. */
const PICKUPS: Array<[string, string | null]> = [
  ["#1", null],
  ["#2", "peripheral-goal"],
  ["#3", "tactical-goal"],
  ["#4", "core-goal"],
  ["#5", "core-goal"],
];

interface Host {
  repo: string;
  home: string;
  state: string;
}

function host(): Host {
  const home = scratch();
  mkdirSync(join(home, ".jig"), { recursive: true });
  return { repo: checkout(), home, state: scratch() };
}

function writeWeights(h: Host, text: string): void {
  writeFileSync(join(h.home, ".jig", "weights.local.yaml"), text);
}

/** One tick's ranking over the pickups, as the tick runs it, with or without the opt-in; `over` replaces the plan's parts. */
function tick(
  h: Host,
  enforce: boolean,
  over: Partial<RepoReport> = {},
): RepoReport {
  const r = report({
    path: h.repo,
    slug: SLUG,
    actions: [
      { ...pickup("PR #7"), stage: "rearm" },
      ...PICKUPS.map(([k]) => pickup(k)),
    ],
    ...over,
  });
  const prepared = preparePriorities(r, {
    slug: SLUG,
    path: h.repo,
    defaultBranch: "main",
    scope: SLUG,
    pickups: PICKUPS.map(([k, l]) => wanted(k, l)),
    unplaced: [],
    trackerComplete: true,
    nowMs: NOW,
    env: { JIG_HOME: join(h.home, ".jig") },
    stateRoot: h.state,
    enforce,
  });
  if (prepared === null) throw new Error(JSON.stringify(r.priorities));
  rankPriorities([prepared], NOW, true, enforce);
  return r;
}

function part(r: RepoReport): PrioritiesReport {
  const p = r.priorities;
  if (p === undefined || "failed" in p)
    throw new Error(`no priorities part: ${JSON.stringify(p)}`);
  return p;
}

const targets = (r: RepoReport) => r.actions.map((a) => a.target);

describe("the host's priorities.enforce setting", () => {
  it("is off unless the machine file says true, and refuses anything else", () => {
    const read = (text: string) => {
      const m = parseMachineConfigText(text, "dispatch.yaml");
      return m.ok ? (m.value.priorities?.enforce ?? false) : m.failure.reason;
    };
    expect(read("repositories: []\n")).toBe(false);
    expect(read("priorities:\n  enforce: true\n")).toBe(true);
    expect(read("priorities:\n  enforce: yes please\n")).toContain(
      "priorities.enforce must be true or false",
    );
    expect(read("priorities:\n  order: true\n")).toContain(
      "priorities has unknown key(s): order",
    );
  });

  it("off, keeps the plan's selection over a sequence of ticks, whatever the weights say", () => {
    const h = host();
    const plan = ["PR #7", ...PICKUPS.map(([k]) => k)];
    for (const weights of [null, "lanes:\n  core: 0\n", "lanes: [core: 1\n"]) {
      if (weights !== null) writeWeights(h, weights);
      const r = tick(h, false);
      expect(targets(r)).toEqual(plan);
      expect(part(r).enforced).toBeUndefined();
      expect(priorityLines(r, "would").at(-1)).toContain(
        "(dispatch's own selection)",
      );
    }
  });

  it("on, starts the pickups in the ranking's order and keeps every other action where it stands", () => {
    const r = tick(host(), true);
    expect(targets(r)).toEqual(["PR #7", "#4", "#3", "#5", "#2", "#1"]);
    const order = part(r).enforced;
    expect(order?.starts.map((s) => [s.target, s.lane])).toEqual([
      ["#4", "core"],
      ["#3", "tactical"],
      ["#5", "core"],
      ["#2", "peripheral"],
      ["#1", "unallocated"],
    ]);
    expect(order?.starts[0]?.objective).toBe("core-goal");
    expect(order?.starts[0]?.why).toContain("position 1: largest deficit");
    expect(order?.starts[4]?.why).toContain("outside every objective");
    const lines = priorityLines(r, "would");
    expect(lines).toContainEqual(
      expect.stringContaining("would    #4 [core core-goal]: position 1"),
    );
  });

  it("on, reads the weights file again on the next tick and changes its first start, with no restart", () => {
    const h = host();
    expect(targets(tick(h, true))[1]).toBe("#4");
    writeWeights(h, "lanes:\n  core: 0\n");
    const paused = tick(h, true);
    expect(targets(paused)).toEqual(["PR #7", "#3", "#2", "#1"]);
    expect(part(paused).enforced?.withheld).toEqual([
      expect.objectContaining({ target: "#4", lane: "core" }),
      expect.objectContaining({ target: "#5", lane: "core" }),
    ]);
    expect(priorityLines(paused, "would")).toContainEqual(
      expect.stringContaining(
        "withheld #4 [core]: its lane core is out of rotation",
      ),
    );
    writeWeights(h, "lanes:\n  core: 50\n  tactical: 0\n");
    expect(targets(tick(h, true))[1]).toBe("#4");
  });

  it("on, ranks only what the plan starts: a pickup a running session holds takes no start from its lane", () => {
    const r = tick(host(), true, {
      actions: ["#1", "#2", "#3", "#5"].map(pickup),
      running: [
        {
          target: "#4",
          stage: "pickup",
          reason: "a session is running for it",
          evidence: {},
        },
      ],
    });
    // #4 would hold core's first start; held, core's next item takes it.
    expect(targets(r)).toEqual(["#5", "#3", "#2", "#1"]);
    expect(part(r).ranking.excluded).toContainEqual({
      key: "#4",
      reason: "running: a session is running for it",
    });
  });

  it("on, lists a withheld pickup as quiet in the report", () => {
    const h = host();
    writeWeights(h, "lanes:\n  core: 0\n");
    const r = tick(h, true);
    expect(r.quiet).toContainEqual({
      target: "#4",
      class: "lane-paused",
      why: expect.stringContaining("its lane core is out of rotation"),
    });
  });

  it("on, a ranking that fails leaves the plan's order and says so", () => {
    const h = host();
    const r = report({
      path: h.repo,
      slug: SLUG,
      actions: PICKUPS.map(([k]) => pickup(k)),
    });
    const prepared = preparePriorities(r, {
      slug: SLUG,
      path: h.repo,
      defaultBranch: "main",
      scope: SLUG,
      pickups: PICKUPS.map(([k, l]) => wanted(k, l)),
      unplaced: [],
      trackerComplete: true,
      nowMs: NOW,
      env: { JIG_HOME: join(h.home, ".jig") },
      // A state root that is a file: the database cannot open.
      stateRoot: join(h.repo, PRIORITIES_FILE),
      enforce: true,
    });
    if (prepared === null) throw new Error("not prepared");
    rankPriorities([prepared], NOW, true, true);
    expect(targets(r)).toEqual(PICKUPS.map(([k]) => k));
    expect(r.priorities).toEqual({
      failed: expect.stringContaining(
        "pickups start in dispatch's own order this tick",
      ),
    });
  });
});

/** The design's sample week, the rows `shared/__tests__/priorities-sample-week.test.ts` checks the ranker against. */
const WEEK: Array<[number, string]> = [
  [1, "core"],
  [2, "tactical"],
  [3, "urgent"],
  [4, "core"],
  [5, "bug-other"],
  [6, "core"],
  [7, "tactical"],
  [8, "bug-high"],
  [9, "peripheral"],
  [10, "core"],
  [11, "core"],
  [12, "tactical"],
  [13, "bug-other"],
  [14, "core"],
  [15, "core"],
  [16, "peripheral"],
];

function classesOf(
  items: SnapshotItem[],
  records: ReturnType<typeof input>["records"],
): Record<string, ItemClass> {
  const out: Record<string, ItemClass> = {};
  for (const c of classify(items, records, null))
    out[c.item.key] = {
      lane: c.lane,
      objective: c.placement?.objective ?? null,
      owners: c.owners as Record<string, string>,
    };
  return out;
}

describe("the enforced order over the design's sample week", () => {
  it("starts each launch's pickup in the sample week's lane, ending core 7, tactical 3, peripheral 2, bug-other 2", () => {
    const previous: WeekCharge[] = Array.from({ length: 16 }, (_, i) => ({
      claimId: `prev-${i}`,
      lane: i === 0 ? "peripheral" : "core",
      objective: null,
      peripheralShare: 0.1,
      atMs: i,
    }));
    const opening = closeWeek("2026-11-09", previous, 0);
    const pools: SnapshotItem[] = [
      ...objectiveWork(20, ["core", "tactical"]),
      ...Array.from({ length: 6 }, (_, i) =>
        item(`#40${i}`, { type: "bug", priority: 3 }),
      ),
    ];
    const charges: WeekCharge[] = [];
    const startN: Partial<Record<WeightedLane, number>> = {};
    let ready = new Set<WeightedLane>();
    let revision = 0;
    for (const [launch, lane] of WEEK) {
      const items = [...pools];
      if (launch >= 9) items.push(...objectiveWork(5, ["peripheral"]));
      if (launch === 3) items.push(item("#500", { priority: 1 }));
      if (launch === 8) items.push(item("#600", { type: "bug", priority: 2 }));
      const base = input({
        snapshot: { readAt: `launch-${launch}`, items },
        capacity: { starts: items.length },
        week: {
          week: "2026-11-16",
          d0: opening.nextDebt,
          d0Reason: null,
          charges: [...charges],
        },
      });
      const weighted = charges.filter(
        (c) => c.lane !== "urgent" && c.lane !== "bug-high",
      ).length;
      const now = readyLanes(base);
      for (const l of now)
        if (!ready.has(l) && launch > 1) {
          startN[l] = weighted;
          revision++;
        }
      ready = now;
      const epochs: LaneEpochs = { revision, startN: { ...startN } };
      const ranking = rank({ ...base, epochs });
      // The plan lists the pickups in reverse key order, so only the ranking can put the owed one first.
      const plan = items
        .filter((i) => !i.isEpic)
        .map((i) => pickup(i.key))
        .reverse();
      const { actions, order } = enforcePickupOrder(
        plan,
        ranking,
        classesOf(items, base.records),
      );
      expect(actions).toHaveLength(plan.length);
      const first = order.starts[0];
      if (first === undefined)
        throw new Error(`launch ${launch} started nothing`);
      expect(`${launch} ${first.lane}`).toBe(`${launch} ${lane}`);
      expect(actions[0]?.target).toBe(first.target);
      charges.push({
        claimId: `claim-${launch}`,
        lane: first.lane as WeekCharge["lane"],
        objective: first.objective,
        peripheralShare: 0.1,
        atMs: launch,
      });
      const at = pools.findIndex((i) => i.key === first.target);
      if (at >= 0) pools.splice(at, 1);
    }
    const count = (l: string) => charges.filter((c) => c.lane === l).length;
    expect([
      count("core"),
      count("tactical"),
      count("peripheral"),
      count("bug-other"),
    ]).toEqual([7, 3, 2, 2]);
  });
});

describe("a batch under the enforced order", () => {
  const items = [...objectiveWork(2, ["core", "peripheral"])];
  const ranking = (w: Partial<Record<WeightedLane, number>>) => {
    const base = input({
      snapshot: { readAt: "now", items },
      capacity: { starts: items.length },
      weights: {
        weights: {
          core: 50,
          tactical: 25,
          peripheral: 10,
          "bug-other": 15,
          ...w,
        },
        source: "file",
        problems: [],
      },
    });
    return { ranking: rank(base), classes: classesOf(items, base.records) };
  };
  const batch = (lead: string, keys: string[]): Action => ({
    ...pickup(lead),
    evidence: {
      batchItems: JSON.stringify(keys.map((key) => ({ key, person: "p" }))),
    },
  });

  it("leaves a paused-lane member out of the batch and withholds it", () => {
    const { ranking: out, classes } = ranking({ peripheral: 0 });
    const { actions, order } = enforcePickupOrder(
      [batch("#101", ["#101", "#301", "#102"])],
      out,
      classes,
    );
    expect(actions[0]?.evidence.batchItems).toBe(
      JSON.stringify([
        { key: "#101", person: "p" },
        { key: "#102", person: "p" },
      ]),
    );
    expect(order.withheld.map((w) => [w.target, w.lane])).toEqual([
      ["#301", "peripheral"],
    ]);
  });

  it("starts the lead alone when only it is left", () => {
    const { ranking: out, classes } = ranking({ peripheral: 0 });
    const { actions } = enforcePickupOrder(
      [batch("#101", ["#101", "#301"])],
      out,
      classes,
    );
    expect(actions[0]?.evidence.batchItems).toBeUndefined();
    expect(actions[0]?.target).toBe("#101");
  });

  it("withholds the whole batch when its lead's lane is paused", () => {
    const { ranking: out, classes } = ranking({ peripheral: 0 });
    const { actions, order } = enforcePickupOrder(
      [batch("#301", ["#301", "#101"])],
      out,
      classes,
    );
    expect(actions).toEqual([]);
    expect(order.withheld.map((w) => w.target)).toEqual(["#301", "#101"]);
  });
});

describe("no lane keeps a start free", () => {
  it("puts every ready pickup of every lane in rotation in the order, the floor owed with no peripheral work ready", () => {
    const items = [
      ...objectiveWork(2, ["core", "tactical"]),
      item("#401", { type: "bug", priority: 3 }),
      item("#700"),
      item("#800", { isEpic: true, state: "ready" }),
    ];
    const base = input({
      snapshot: { readAt: "now", items },
      capacity: { starts: items.length },
      // Owed more than a whole start: the floor would pick peripheral work, and none is ready.
      week: { week: "2026-11-16", d0: 3, d0Reason: null, charges: [] },
    });
    const ranking = rank(base);
    expect(ranking.floor.owed).toBeGreaterThanOrEqual(1);
    const plan = items
      .filter((i) => i.key.startsWith("#") && !["#100", "#200"].includes(i.key))
      .map((i) => pickup(i.key));
    const { actions, order } = enforcePickupOrder(
      plan,
      ranking,
      classesOf(items, base.records),
    );
    expect(order.withheld).toEqual([]);
    expect(actions.map((a) => a.target).sort()).toEqual(
      plan.map((a) => a.target).sort(),
    );
    // Lent while no peripheral work is ready; the unallocated item and the epic follow the ranked work.
    expect(order.starts.map((s) => s.lane).slice(-2)).toEqual([
      "unallocated",
      "unallocated",
    ]);
    expect(order.starts.at(-1)?.why).toContain("not ranked: an epic");
  });

  it("names a pickup that did not start and why", () => {
    const r = report({
      priorities: {
        record: { source: "x", blocked: null, lastValid: null, revision: 1 },
        weights: { source: "defaults", problems: [] },
        ranking: rank(input()),
        enforced: {
          starts: [
            { target: "#1", lane: "core", objective: "o", why: "position 1" },
            {
              target: "#2",
              lane: "tactical",
              objective: null,
              why: "position 2",
            },
          ],
          withheld: [],
        },
      },
      launches: [
        {
          target: "#1",
          action: "pickup",
          outcome: "waits",
          account: null,
          record: null,
          detail: "the epic is at its width",
        },
        {
          target: "#2",
          action: "pickup",
          outcome: "launched",
          account: "a",
          record: "r",
          detail: "launched",
        },
      ],
    });
    const lines = priorityLines(r, "wants");
    expect(lines).toContainEqual(
      "  waits    #1 [core o]: did not start, and the next in the order may take the start: the epic is at its width",
    );
    expect(lines).toContainEqual("  started  #2 [tactical]: position 2");
  });
});

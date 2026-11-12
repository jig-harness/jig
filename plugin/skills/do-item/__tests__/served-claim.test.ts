import { expect, test } from "bun:test";
import { claimServedIssue } from "../scripts/lib/served-claim.ts";
import type { Tracker, TrackerUser } from "../scripts/lib/tracker/port.ts";

const person: TrackerUser = { id: "person", name: "dana" };
function world(inherited = false) {
  const holders = new Map<string, TrackerUser[]>([
    ["#1", inherited ? [] : [person]],
    ["#3", [person]],
    ["#2", []],
  ]);
  const writes: string[] = [];
  let held = false;
  const tracker = {
    user: async () => person,
    listRelations: async () => [],
    stateName: () => "In Progress",
    getIssue: async (key: string) => ({
      identifier: key,
      parent:
        key === "#1"
          ? { identifier: "#2" }
          : key === "#2"
            ? { identifier: "#3" }
            : null,
      labels: key === "#1" && held ? ["hitl:legal"] : ["epic"],
      state: {
        name: key === "#1" && writes.includes("start") ? "In Progress" : "Todo",
        type:
          key === "#1" && writes.includes("start") ? "started" : "unstarted",
      },
    }),
    poolIssue: async (key: string) => ({
      identifier: key,
      labels: [],
      truncated: [],
      state: {
        name: writes.length ? "In Progress" : "Todo",
        type: writes.length ? "started" : "unstarted",
      },
    }),
    assignees: async (key: string) => holders.get(key) ?? [],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    assignUnassigned: async (key: string, user: TrackerUser) => {
      writes.push("assign");
      holders.set(key, [user]);
      return true;
    },
    transition: async () => {
      writes.push("start");
    },
  } as unknown as Tracker;
  return {
    tracker,
    holders,
    writes,
    hold: () => {
      held = true;
    },
  };
}
test("keeps the served person as the only assignee", async () => {
  const w = world();
  expect(
    (await claimServedIssue(w.tracker, "#1", { person: "dana" })).outcome,
  ).toBe("claimed");
  expect(w.writes).toEqual(["start"]);
  expect(w.holders.get("#1")).toEqual([person]);
});
test("inherits a writer's assignment two levels above", async () => {
  const w = world(true);
  expect(
    (
      await claimServedIssue(w.tracker, "#1", {
        person: "dana",
        ancestor: "#3",
      })
    ).outcome,
  ).toBe("claimed");
  expect(w.writes).toEqual(["assign", "start"]);
});
test("refuses holds and conflicting intermediate assignees without writing", async () => {
  const w = world(true);
  w.hold();
  expect(
    (
      await claimServedIssue(w.tracker, "#1", {
        person: "dana",
        ancestor: "#3",
      })
    ).outcome,
  ).toBe("refused");
  expect(w.writes).toEqual([]);
  const other = world(true);
  other.holders.set("#2", [{ id: "other", name: "other" }]);
  expect(
    (
      await claimServedIssue(other.tracker, "#1", {
        person: "dana",
        ancestor: "#3",
      })
    ).outcome,
  ).toBe("refused");
  expect(other.writes).toEqual([]);
});
test("an untrusted assigner never starts work", async () => {
  const w = world();
  w.tracker.assignedBy = async () => ({
    id: "guest",
    name: "guest",
    trusted: false,
  });
  expect(
    (await claimServedIssue(w.tracker, "#1", { person: "dana" })).outcome,
  ).toBe("refused");
  expect(w.writes).toEqual([]);
});
test("an assignment racing the write is retained and the claim stands down", async () => {
  const w = world(true);
  w.tracker.assignUnassigned = async (key) => {
    w.holders.set(key, [person, { id: "other", name: "other" }]);
    return false;
  };
  expect(
    (
      await claimServedIssue(w.tracker, "#1", {
        person: "dana",
        ancestor: "#3",
      })
    ).outcome,
  ).toBe("stood_down");
  expect(w.writes).toEqual([]);
  expect(w.holders.get("#1")).toHaveLength(2);
});
test("blocked, unreadable and unsupported inherited claims never write", async () => {
  const blocked = world();
  blocked.tracker.listRelations = async () => [
    { type: "blocked_by", issue: "#9" },
  ];
  expect(
    (await claimServedIssue(blocked.tracker, "#1", { person: "dana" })).outcome,
  ).toBe("refused");
  expect(blocked.writes).toEqual([]);
  const unsupported = world(true);
  delete unsupported.tracker.assignUnassigned;
  expect(
    (
      await claimServedIssue(unsupported.tracker, "#1", {
        person: "dana",
        ancestor: "#3",
      })
    ).outcome,
  ).toBe("refused");
  expect(unsupported.writes).toEqual([]);
  const truncated = world();
  const read = truncated.tracker.poolIssue;
  truncated.tracker.poolIssue = async (key) =>
    ({ ...(await read(key)), truncated: ["labels"] }) as never;
  expect(
    (await claimServedIssue(truncated.tracker, "#1", { person: "dana" }))
      .outcome,
  ).toBe("refused");
  expect(truncated.writes).toEqual([]);
});
test("a moved ancestor and a new hold between validation reads refuse the claim", async () => {
  const w = world(true);
  const read = w.tracker.getIssue;
  let reads = 0;
  w.tracker.getIssue = async (key) => {
    const issue = await read(key);
    if (key === "#1" && ++reads > 1)
      return issue ? { ...issue, parent: null } : null;
    return issue;
  };
  expect(
    (
      await claimServedIssue(w.tracker, "#1", {
        person: "dana",
        ancestor: "#3",
      })
    ).outcome,
  ).toBe("refused");
  expect(w.writes).toEqual([]);
  const h = world();
  const get = h.tracker.getIssue;
  let called = 0;
  h.tracker.getIssue = async (key) => {
    if (++called > 1) h.hold();
    return get(key);
  };
  expect(
    (await claimServedIssue(h.tracker, "#1", { person: "dana" })).outcome,
  ).toBe("refused");
  expect(h.writes).toEqual([]);
});

test("GitHub's inherited assignment adds without replacing a racing assignee", async () => {
  const { gitHub } = await import("./github-fixtures.ts");
  let reads = 0;
  const fake = gitHub((c) => {
    if (c.op === "TrackerAssignees") {
      reads++;
      return {
        repository: {
          issue: {
            id: "I_5",
            assignees: {
              totalCount: reads === 1 ? 0 : 2,
              nodes:
                reads === 1
                  ? []
                  : [
                      { id: "person", login: "dana" },
                      { id: "other", login: "other" },
                    ],
            },
          },
        },
      };
    }
    if (c.op === "TrackerAddAssignee")
      return {
        addAssigneesToAssignable: { assignable: { __typename: "Issue" } },
      };
    throw new Error(`unexpected ${c.op}`);
  });
  expect(await fake.t.assignUnassigned?.("#5", person)).toBe(false);
  expect(fake.calls.some((c) => c.op === "TrackerAssign")).toBe(false);
});

test("GitHub's inherited assignment selects only what the Assignable interface declares", async () => {
  const { gitHub } = await import("./github-fixtures.ts");
  let reads = 0;
  const fake = gitHub((c) => {
    if (c.op === "TrackerAssignees") {
      reads++;
      return {
        repository: {
          issue: {
            id: "I_5",
            assignees: {
              totalCount: reads === 1 ? 0 : 1,
              nodes: reads === 1 ? [] : [{ id: "person", login: "dana" }],
            },
          },
        },
      };
    }
    if (c.op === "TrackerAddAssignee")
      return {
        addAssigneesToAssignable: { assignable: { __typename: "Issue" } },
      };
    throw new Error(`unexpected ${c.op}`);
  });
  expect(await fake.t.assignUnassigned?.("#5", person)).toBe(true);
  const query = fake.calls.find((c) => c.op === "TrackerAddAssignee")?.query;
  // `Assignable` is an interface with no `id` field: GitHub rejects a plain
  // `id` there at validation, so only `__typename` or a fragment may be read.
  const selection = /assignable\s*\{([^}]*)\}/.exec(query ?? "")?.[1] ?? "";
  expect(selection.trim()).toBe("__typename");
});

test("claim CLI refuses incomplete and duplicate served options before tracker access", async () => {
  const { expectSpawnExit } = await import(
    "../../../../lib/test-helpers/expect-spawn-exit.ts"
  );
  const { join } = await import("node:path");
  for (const args of [
    ["--for"],
    ["--ancestor", "#3"],
    ["--for=dana", "--for=other"],
    ["--for="],
  ]) {
    expect(args.length).toBeGreaterThan(0);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/tracker.ts"),
        "claim",
        "#1",
        ...args,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, JIG_USER_LAYER: "off" },
      },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expectSpawnExit({ exitCode: await child.exited, stdout, stderr }, 2);
  }
});

test("a hold arriving during transition stands down without rolling back", async () => {
  const w = world();
  w.tracker.transition = async () => {
    w.writes.push("start");
    w.hold();
  };
  expect(
    (await claimServedIssue(w.tracker, "#1", { person: "dana" })).outcome,
  ).toBe("stood_down");
  expect(w.writes).toEqual(["start"]);
});

test("post-write holds, incomplete facts, blockers and lost ancestor authority stand down", async () => {
  const poolHold = world();
  const poolRead = poolHold.tracker.poolIssue;
  poolHold.tracker.poolIssue = async (key) => {
    const p = await poolRead(key);
    return p && poolHold.writes.includes("start")
      ? { ...p, labels: ["jig:hold"] }
      : p;
  };
  expect(
    (await claimServedIssue(poolHold.tracker, "#1", { person: "dana" }))
      .outcome,
  ).toBe("stood_down");
  const incomplete = world();
  const incompleteRead = incomplete.tracker.poolIssue;
  incomplete.tracker.poolIssue = async (key) => {
    const p = await incompleteRead(key);
    return p && incomplete.writes.includes("start")
      ? { ...p, truncated: ["labels"] }
      : p;
  };
  expect(
    (await claimServedIssue(incomplete.tracker, "#1", { person: "dana" }))
      .outcome,
  ).toBe("stood_down");
  const blocked = world();
  blocked.tracker.listRelations = async () =>
    blocked.writes.includes("start")
      ? [{ type: "blocked_by", issue: "#9" }]
      : [];
  expect(
    (await claimServedIssue(blocked.tracker, "#1", { person: "dana" })).outcome,
  ).toBe("stood_down");
  const ancestor = world(true);
  ancestor.tracker.transition = async () => {
    ancestor.writes.push("start");
    ancestor.holders.set("#3", []);
  };
  expect(
    (
      await claimServedIssue(ancestor.tracker, "#1", {
        person: "dana",
        ancestor: "#3",
      })
    ).outcome,
  ).toBe("stood_down");
  expect(ancestor.writes).toEqual(["assign", "start"]);
});
test("claim_from refuses a state outside it before any write, inherited claims included", async () => {
  const names: Record<string, string> = {
    backlog: "Backlog",
    todo: "Todo",
    in_progress: "In Progress",
  };
  const named = (w: ReturnType<typeof world>) => {
    w.tracker.stateName = ((s: string) =>
      names[s] ?? s) as Tracker["stateName"];
    return w;
  };
  const allowed = named(world());
  expect(
    (
      await claimServedIssue(allowed.tracker, "#1", {
        person: "dana",
        claimFrom: ["todo"],
      })
    ).outcome,
  ).toBe("claimed");
  const inherited = named(world(true));
  expect(
    await claimServedIssue(inherited.tracker, "#1", {
      person: "dana",
      ancestor: "#3",
      claimFrom: ["backlog"],
    }),
  ).toMatchObject({ outcome: "refused", why: "state" });
  expect(inherited.writes).toEqual([]);
});
test("a state that leaves claim_from after the assignment write stands down", async () => {
  const w = world(true);
  const names: Record<string, string> = {
    backlog: "Backlog",
    todo: "Todo",
    in_progress: "In Progress",
  };
  w.tracker.stateName = ((s: string) => names[s] ?? s) as Tracker["stateName"];
  const read = w.tracker.getIssue.bind(w.tracker);
  w.tracker.getIssue = (async (key: string) => {
    const issue = await read(key);
    if (key !== "#1" || !issue || !w.writes.includes("assign")) return issue;
    return { ...issue, state: { name: "Backlog", type: "backlog" } };
  }) as Tracker["getIssue"];
  expect(
    await claimServedIssue(w.tracker, "#1", {
      person: "dana",
      ancestor: "#3",
      claimFrom: ["todo"],
    }),
  ).toMatchObject({ outcome: "stood_down", issue: "#1" });
  expect(w.writes).toEqual(["assign"]);
});
function flipAfter(w: ReturnType<typeof world>, reads: number, to: unknown) {
  const names: Record<string, string> = {
    backlog: "Backlog",
    todo: "Todo",
    in_progress: "In Progress",
  };
  w.tracker.stateName = ((s: string) => names[s] ?? s) as Tracker["stateName"];
  const read = w.tracker.getIssue.bind(w.tracker);
  let seen = 0;
  w.tracker.getIssue = (async (key: string) => {
    const issue = await read(key);
    if (key !== "#1" || !issue) return issue;
    seen += 1;
    return seen > reads ? to : issue;
  }) as Tracker["getIssue"];
}
test("an unreadable item before the inherited assignment write refuses without writing", async () => {
  const w = world(true);
  flipAfter(w, 5, null);
  expect(
    await claimServedIssue(w.tracker, "#1", {
      person: "dana",
      ancestor: "#3",
      claimFrom: ["todo"],
    }),
  ).toMatchObject({ outcome: "refused", why: "state" });
  expect(w.writes).toEqual([]);
});
test("a direct claim whose state leaves claim_from before any write keeps the state refusal", async () => {
  const w = world();
  flipAfter(w, 3, {
    identifier: "#1",
    parent: { identifier: "#2" },
    labels: ["epic"],
    state: { name: "Backlog", type: "unstarted" },
  });
  expect(
    await claimServedIssue(w.tracker, "#1", {
      person: "dana",
      claimFrom: ["todo"],
    }),
  ).toMatchObject({ outcome: "refused", why: "state" });
  expect(w.writes).toEqual([]);
});
test("a direct claim whose final state is started but outside claim_from refuses, not stands down", async () => {
  const w = world();
  flipAfter(w, 5, {
    identifier: "#1",
    parent: { identifier: "#2" },
    labels: ["epic"],
    state: { name: "In Review", type: "started" },
  });
  expect(
    await claimServedIssue(w.tracker, "#1", {
      person: "dana",
      claimFrom: ["todo"],
    }),
  ).toMatchObject({ outcome: "refused", why: "state" });
  expect(w.writes).toEqual([]);
});
/** `world` whose item reads Blocked (unstarted type) from its `from`th getIssue read of "#1" on. */
function blockedFrom(from: number, inherited: boolean) {
  const w = world(inherited);
  const base = w.tracker.getIssue.bind(w.tracker);
  const tracker = w.tracker as unknown as Record<string, unknown>;
  let reads = 0;
  tracker.stateName = (s: string) =>
    s === "blocked" ? "Blocked" : "In Progress";
  tracker.getIssue = async (key: string) => {
    const issue = await base(key);
    if (key !== "#1" || !issue || ++reads < from) return issue;
    return { ...issue, state: { name: "Blocked", type: "unstarted" } };
  };
  return w;
}
test("a served claim refuses an item that is Blocked, before any write", async () => {
  const w = blockedFrom(1, false);
  const result = await claimServedIssue(w.tracker, "#1", { person: "dana" });
  expect(result).toMatchObject({ outcome: "refused", why: "blocked" });
  expect(w.writes).toEqual([]);
});
/** How many reads of "#1" a clean claim has made when it issues `write`. */
async function readsAtWrite(write: "assign" | "start", inherited: boolean) {
  const w = world(inherited);
  const base = w.tracker.getIssue.bind(w.tracker);
  const tracker = w.tracker as unknown as Record<string, unknown>;
  const at: Record<string, number> = {};
  let reads = 0;
  tracker.stateName = (s: string) =>
    s === "blocked" ? "Blocked" : "In Progress";
  tracker.getIssue = async (key: string) => {
    if (key === "#1") reads++;
    return base(key);
  };
  const assign = w.tracker.assignUnassigned?.bind(w.tracker);
  if (assign)
    w.tracker.assignUnassigned = async (key, user) => {
      at.assign = reads;
      return assign(key, user);
    };
  const transition = w.tracker.transition.bind(w.tracker);
  w.tracker.transition = async (key, state) => {
    at.start = reads;
    return transition(key, state);
  };
  await claimServedIssue(w.tracker, "#1", {
    person: "dana",
    ...(inherited ? { ancestor: "#3" } : {}),
  });
  return at[write];
}
test("an item blocked at the final read before an inherited assignment is refused without writing", async () => {
  const w = blockedFrom(await readsAtWrite("assign", true), true);
  const result = await claimServedIssue(w.tracker, "#1", {
    person: "dana",
    ancestor: "#3",
  });
  expect(result).toMatchObject({ outcome: "refused", why: "blocked" });
  expect(w.writes).toEqual([]);
});
test("an item blocked at the final read before the start write is never overwritten", async () => {
  const w = blockedFrom(await readsAtWrite("start", false), false);
  const result = await claimServedIssue(w.tracker, "#1", { person: "dana" });
  expect(result).toMatchObject({ outcome: "refused", why: "blocked" });
  expect(w.writes).toEqual([]);
});
test("an inherited claim blocked after its assignment write stands down without starting", async () => {
  const w = blockedFrom((await readsAtWrite("assign", true)) + 1, true);
  const result = await claimServedIssue(w.tracker, "#1", {
    person: "dana",
    ancestor: "#3",
  });
  expect(result).toMatchObject({ outcome: "stood_down" });
  expect(w.writes).toEqual(["assign"]);
});
test("a claim reads no extra state when the tracker has no blocked state", async () => {
  const count = async (blockedName: string | null) => {
    const w = world();
    let reads = 0;
    const base = w.tracker.getIssue.bind(w.tracker);
    const tracker = w.tracker as unknown as Record<string, unknown>;
    const stateName = w.tracker.stateName.bind(w.tracker);
    tracker.stateName = (s: string) =>
      s === "blocked" ? blockedName : stateName(s as never);
    tracker.getIssue = async (key: string) => {
      reads++;
      return base(key);
    };
    await claimServedIssue(w.tracker, "#1", { person: "dana" });
    return reads;
  };
  expect(await count(null)).toBe((await count("Blocked")) - 2);
});

/**
 * Claims across hosts: the claim marker as the claim's token
 * (`claim-token.ts`). Two hosts claiming one item with the same identity
 * write the same assignee and state, so only the markers tell them apart:
 * of the markers on the item the earliest wins, the other claim refuses
 * with nothing written to the item. Over an in-memory comment store, then
 * two hosts racing over each adapter's fake transport.
 */
import { describe, expect, it } from "bun:test";
import type { Clock } from "../../../shared/clock.ts";
import {
  type ClaimResult,
  type ClaimTracker,
  claimIssue,
} from "../scripts/lib/claim.ts";
import {
  type ClaimOutcome,
  claimMarkerBody,
  claimOutcomeBody,
  readClaimMarker,
  readClaimOutcome,
} from "../scripts/lib/claim-marker.ts";
import {
  CLAIM_LAPSE_MS,
  claimWithMarker,
  RECOVERY_READS,
  type TokenTracker,
} from "../scripts/lib/claim-token.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import type { CommentFact, Tracker } from "../scripts/lib/tracker/port.ts";
import {
  githubClaimStore,
  jiraClaimStore,
  linearClaimStore,
} from "./claim-fakes.ts";
import { conn, gitHub, issueNode, oneIssue } from "./github-fixtures.ts";
import {
  type Call,
  FACTORY,
  issue as jiraIssue,
  jira,
  page,
} from "./jira-fixtures.ts";

const STATES = parseTrackerConfig({}).states;
/** No waits between read-backs. */
const CLOCK: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };
const FACTS = { session: "s", branch: "b", claimant: "factory" };

/** A marker another claim posted, `ago` milliseconds before now. */
function theirs(id: string, ago: number, trusted = true): CommentFact {
  return {
    id,
    trusted,
    createdAt: new Date(Date.now() - ago).toISOString(),
    body: claimMarkerBody({
      attempt: `other-${id}`,
      ...FACTS,
      at: new Date().toISOString(),
    }),
  };
}

/** The outcome record another claim's attempt `other-<id>` posted. */
function outcomeOf(id: string, outcome: ClaimOutcome): CommentFact {
  return {
    id: `${id}-outcome`,
    trusted: true,
    createdAt: new Date().toISOString(),
    body: claimOutcomeBody({
      attempt: `other-${id}`,
      outcome,
      at: new Date().toISOString(),
    }),
  };
}

/** The ids of the claim markers among `comments`. */
const markerIds = (comments: Array<{ id?: unknown; body?: unknown }>) =>
  comments
    .filter((c) => readClaimMarker(String(c.body)) !== null)
    .map((c) => c.id);
/** The outcomes recorded among `comments`, in order. */
const outcomesIn = (comments: Array<{ body?: unknown }>) =>
  comments.flatMap((c) => {
    const o = readClaimOutcome(String(c.body));
    return o === null ? [] : [o.outcome];
  });

/** One item's comments, shared by every host that reads it. */
function store(initial: CommentFact[] = []) {
  const comments = [...initial];
  let n = 0;
  const log: string[] = [];
  const tracker = (
    overrides: Partial<TokenTracker> = {},
  ): TokenTracker & { log: string[] } => ({
    log,
    issueComments: async () => ({ uuid: "u", comments: [...comments] }),
    postComment: async (_key, body) => {
      n++;
      log.push("post");
      comments.push({
        id: `c${n}`,
        body,
        createdAt: new Date().toISOString(),
        trusted: true,
      });
    },
    deleteComment: async (_key, id) => {
      log.push(`delete ${id}`);
      const at = comments.findIndex((c) => c.id === id);
      if (at >= 0) comments.splice(at, 1);
    },
    ...overrides,
  });
  return { comments, tracker, log };
}

const claimed = (): Promise<ClaimResult> =>
  Promise.resolve({
    outcome: "claimed",
    issue: "#5",
    claimant: { id: "u", name: "factory" },
    state: "In Progress",
  });

describe("the claim marker as the claim's token", () => {
  it("of two claims at once, the earlier marker wins and the other refuses, withdrawing its own", async () => {
    const s = store();
    let claims = 0;
    const body = () => {
      claims++;
      return claimed();
    };
    const [a, b] = await Promise.all([
      claimWithMarker(s.tracker(), "#5", FACTS, body, CLOCK),
      claimWithMarker(s.tracker(), "#5", FACTS, body, CLOCK),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["claimed", "refused"]);
    const lost = a.outcome === "refused" ? a : b;
    expect(lost).toMatchObject({ why: "marker" });
    expect(claims).toBe(1);
    // Only the winner's marker is left, beside both outcomes.
    expect(markerIds(s.comments)).toEqual(["c1"]);
    expect(outcomesIn(s.comments).sort()).toEqual(["claimed", "released"]);
  });

  it("claims, and reports the marker confirmed, when its marker is the earliest", async () => {
    const s = store();
    const out = await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK);
    expect(out).toMatchObject({
      outcome: "claimed",
      marker: { posted: true, confirmed: true },
    });
    expect(readClaimMarker(s.comments[0]?.body ?? "")).toMatchObject(FACTS);
  });

  it("refuses, running no claim, when a live marker is earlier", async () => {
    const s = store([theirs("x", 60_000)]);
    let ran = false;
    const out = await claimWithMarker(
      s.tracker(),
      "#5",
      FACTS,
      () => {
        ran = true;
        return claimed();
      },
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    expect(ran).toBe(false);
    expect(markerIds(s.comments)).toEqual(["x"]);
    expect(outcomesIn(s.comments)).toEqual(["released"]);
  });

  it("ignores a marker older than the lapse window", async () => {
    const s = store([theirs("x", CLAIM_LAPSE_MS + 60_000)]);
    expect(
      (await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK)).outcome,
    ).toBe("claimed");
  });

  it("ignores an earlier marker from an untrusted author", async () => {
    const s = store([theirs("x", 1_000, false)]);
    expect(
      (await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK)).outcome,
    ).toBe("claimed");
  });

  it("refuses, writing nothing, when its marker cannot be posted", async () => {
    const s = store();
    let ran = false;
    const out = await claimWithMarker(
      s.tracker({
        postComment: async () => {
          throw new Error("the tracker is down");
        },
      }),
      "#5",
      FACTS,
      () => {
        ran = true;
        return claimed();
      },
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    expect(out.outcome === "refused" && out.reason).toContain(
      "could not be posted",
    );
    expect(ran).toBe(false);
  });

  it("refuses, writing nothing, when its marker cannot be read back", async () => {
    const s = store();
    let ran = false;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          throw new Error("unreadable");
        },
      }),
      "#5",
      FACTS,
      () => {
        ran = true;
        return claimed();
      },
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    expect(out.outcome === "refused" && out.reason).toContain(
      "could not be read back",
    );
    expect(ran).toBe(false);
  });

  it("refuses when its own marker never shows among the trusted comments", async () => {
    const s = store();
    let reads = 0;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          return { uuid: "u", comments: [] };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
    // Three read-backs, then the withdrawal's own listing.
    expect(reads).toBe(4);
  });

  it("withdraws its marker when the claim itself throws", async () => {
    const s = store();
    await expect(
      claimWithMarker(
        s.tracker(),
        "#5",
        FACTS,
        async () => {
          throw new Error("tracker down");
        },
        CLOCK,
      ),
    ).rejects.toThrow("tracker down");
    expect(markerIds(s.comments)).toEqual([]);
    expect(outcomesIn(s.comments)).toEqual(["released"]);
  });

  it("stands down when an earlier marker shows only after the claim wrote", async () => {
    // The other host's marker is earlier, but the first listing lags past it.
    const s = store();
    const late = theirs("x", 1_000);
    let reads = 0;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          return {
            uuid: "u",
            comments: reads === 1 ? [...s.comments] : [late, ...s.comments],
          };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({
      outcome: "stood_down",
      recovery: "unresolved",
    });
    expect(out.outcome === "stood_down" && out.reason).toContain(
      "a person must check it",
    );
    // Every recovery read, then the unresolved outcome, then its marker withdrawn.
    expect(reads).toBe(2 + RECOVERY_READS);
    expect(s.log).toEqual(["post", "post", "delete c1"]);
    expect(outcomesIn(s.comments)).toEqual(["unresolved"]);
  });

  /** A claim whose first read misses the earlier marker `late`, which every later read lists beside `after`. */
  function lagging(
    s: ReturnType<typeof store>,
    late: CommentFact,
    after: (read: number) => CommentFact[],
  ) {
    let reads = 0;
    return {
      reads: () => reads,
      tracker: s.tracker({
        issueComments: async () => {
          reads++;
          return {
            uuid: "u",
            comments:
              reads === 1
                ? [...s.comments]
                : [late, ...s.comments, ...after(reads)],
          };
        },
      }),
    };
  }

  it("keeps its claim after the write when the earlier attempt recorded that it released the item", async () => {
    // The earlier attempt refused on seeing this claim's start; its marker still lists.
    const s = store();
    const late = theirs("x", 1_000);
    const h = lagging(s, late, (read) =>
      read >= 4 ? [outcomeOf("x", "released")] : [],
    );
    const out = await claimWithMarker(h.tracker, "#5", FACTS, claimed, CLOCK);
    expect(out).toMatchObject({
      outcome: "claimed",
      recovery: "reclaimed",
      marker: { posted: true, confirmed: true },
    });
    expect(markerIds(s.comments)).toEqual(["c1"]);
    expect(outcomesIn(s.comments)).toEqual(["claimed"]);
  });

  it("stands down after the write, leaving the item to the earlier attempt, when that attempt recorded its claim", async () => {
    const s = store();
    const late = theirs("x", 1_000);
    const h = lagging(s, late, (read) =>
      read >= 3 ? [outcomeOf("x", "claimed")] : [],
    );
    let writes = 0;
    const out = await claimWithMarker(
      h.tracker,
      "#5",
      FACTS,
      () => {
        writes++;
        return claimed();
      },
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "stood_down", recovery: "held" });
    // Its writes were the claim's only ones: nothing undoes them.
    expect(writes).toBe(1);
    expect(markerIds(s.comments)).toEqual([]);
    expect(outcomesIn(s.comments)).toEqual(["released"]);
  });

  it("ignores an earlier marker whose attempt recorded its release, before it writes", async () => {
    const s = store([theirs("x", 1_000), outcomeOf("x", "released")]);
    const out = await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK);
    expect(out).toMatchObject({ outcome: "claimed" });
    expect(out.recovery).toBeUndefined();
  });

  it("stands down unresolved, never reclaiming, when its own marker is gone after the write", async () => {
    const s = store();
    let reads = 0;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          // From the read after the write on, its marker is gone.
          const comments =
            reads === 1
              ? [...s.comments]
              : s.comments.filter((c) => readClaimMarker(c.body) === null);
          return { uuid: "u", comments };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    // A listing that lost its own marker may miss an earlier one too.
    expect(out).toMatchObject({
      outcome: "stood_down",
      recovery: "unresolved",
    });
    expect(reads).toBe(2 + RECOVERY_READS);
    expect(outcomesIn(s.comments)).toEqual(["unresolved"]);
  });

  it("with its own marker gone, yields to an earlier attempt of the same second that recorded its claim", async () => {
    const s = store();
    let reads = 0;
    let rival: CommentFact | undefined;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          const own = s.comments.find((c) => readClaimMarker(c.body) !== null);
          rival ??= {
            ...theirs("x", 0),
            createdAt: (own as CommentFact).createdAt,
          };
          if (reads === 1) return { uuid: "u", comments: [...s.comments] };
          // After the write its own marker is gone, and the rival's shows with its claim.
          return {
            uuid: "u",
            comments: [
              rival,
              ...s.comments.filter((c) => readClaimMarker(c.body) === null),
              outcomeOf("x", "claimed"),
            ],
          };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({ outcome: "stood_down", recovery: "held" });
  });

  it("counts an earlier attempt that stood down unresolved as holding nothing", async () => {
    const s = store();
    const h = lagging(s, theirs("x", 1_000), (read) =>
      read >= 3 ? [outcomeOf("x", "unresolved")] : [],
    );
    const out = await claimWithMarker(h.tracker, "#5", FACTS, claimed, CLOCK);
    expect(out).toMatchObject({ outcome: "claimed", recovery: "reclaimed" });
  });

  it("keeps the question open when an earlier marker vanishes without an outcome", async () => {
    const s = store();
    const late = theirs("x", 1_000);
    // Listed once after the write, then gone with no outcome recorded.
    const h = lagging(s, late, () => []);
    let reads = 0;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async (key) => {
          reads++;
          const listed = await h.tracker.issueComments(key);
          return reads <= 2
            ? listed
            : {
                uuid: "u",
                comments: listed.comments.filter((c) => c !== late),
              };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({
      outcome: "stood_down",
      recovery: "unresolved",
    });
  });

  it("reads an attempt's first outcome, not a later one naming it", async () => {
    const s = store([
      theirs("x", 1_000),
      outcomeOf("x", "claimed"),
      { ...outcomeOf("x", "released"), id: "x-later" },
    ]);
    const out = await claimWithMarker(s.tracker(), "#5", FACTS, claimed, CLOCK);
    expect(out).toMatchObject({ outcome: "refused", why: "marker" });
  });

  it("stands down unresolved when its markers cannot be read again after the write", async () => {
    const s = store();
    const late = theirs("x", 1_000);
    let reads = 0;
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          if (reads >= 3) throw new Error("unreadable");
          return {
            uuid: "u",
            comments: reads === 1 ? [...s.comments] : [late, ...s.comments],
          };
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({
      outcome: "stood_down",
      recovery: "unresolved",
    });
    expect(out.outcome === "stood_down" && out.reason).toContain(
      "could not be read again",
    );
    expect(outcomesIn(s.comments)).toEqual(["unresolved"]);
  });

  it("withdraws its marker when the claim itself refuses", async () => {
    const s = store();
    const out = await claimWithMarker(
      s.tracker(),
      "#5",
      FACTS,
      async () => ({
        outcome: "refused",
        issue: "#5",
        why: "in_progress",
        reason: "held",
      }),
      CLOCK,
    );
    expect(out.outcome).toBe("refused");
    expect(markerIds(s.comments)).toEqual([]);
    expect(outcomesIn(s.comments)).toEqual(["released"]);
  });

  it("keeps a claim whose read after the write fails, saying the marker is unconfirmed", async () => {
    const s = store();
    let reads = 0;
    const base = s.tracker();
    const out = await claimWithMarker(
      s.tracker({
        issueComments: async (key) => {
          reads++;
          if (reads > 1) throw new Error("unreadable");
          return base.issueComments(key);
        },
      }),
      "#5",
      FACTS,
      claimed,
      CLOCK,
    );
    expect(out).toMatchObject({
      outcome: "claimed",
      marker: { posted: true, confirmed: false, reason: "unreadable" },
    });
  });
});

/** One item's assignee and state, claimed through `claimIssue`. */
function item() {
  const me = { id: "u", name: "factory" };
  const at = { state: "Todo", assignees: [] as Array<typeof me> };
  const names: Record<string, string> = {
    todo: "Todo",
    in_progress: "In Progress",
  };
  const tracker = {
    viewer: async () => me,
    assignees: async () => [...at.assignees],
    assign: async (_key: string, user: typeof me) => {
      at.assignees = [user];
    },
    poolIssue: async () => ({
      state: {
        name: at.state,
        type: at.state === "Todo" ? "unstarted" : "started",
      },
      nativeType: null,
    }),
    transition: async () => {
      at.state = "In Progress";
    },
    stateName: (state: string) => names[state] ?? null,
  } as unknown as ClaimTracker;
  return { at, tracker };
}

describe("a claim that meets an earlier marker after it wrote the item", () => {
  it("keeps the item when the earlier attempt refused on seeing it started", async () => {
    // B's first read lags past A's marker, so B claims and starts the item.
    // A, the earlier marker, then refuses because the item is in progress.
    // B's read after its write still lists A's withdrawn marker.
    const s = store();
    const it5 = item();
    let ghost: CommentFact | undefined;
    const a = s.tracker({
      postComment: async (_key, body) => {
        const comment: CommentFact = {
          id: `a${s.comments.length}`,
          body,
          createdAt: new Date(Date.now() - 1_000).toISOString(),
          trusted: true,
        };
        if (readClaimMarker(body) !== null) {
          ghost = comment;
          s.comments.unshift(comment);
        } else s.comments.push(comment);
      },
    });
    let reads = 0;
    let first: Awaited<ReturnType<typeof claimWithMarker>> | undefined;
    const b = await claimWithMarker(
      s.tracker({
        issueComments: async () => {
          reads++;
          const comments = [...s.comments];
          if (reads > 1 && ghost && !comments.includes(ghost))
            comments.unshift(ghost);
          return { uuid: "u", comments };
        },
      }),
      "#5",
      FACTS,
      async () => {
        const out = await claimIssue(it5.tracker, "#5");
        first = await claimWithMarker(
          a,
          "#5",
          FACTS,
          () => claimIssue(it5.tracker, "#5"),
          CLOCK,
        );
        return out;
      },
      CLOCK,
    );
    expect(first).toMatchObject({ outcome: "refused", why: "in_progress" });
    expect(b.outcome).toBe("claimed");
    expect(it5.at).toEqual({
      state: "In Progress",
      assignees: [{ id: "u", name: "factory" }],
    });
    expect(outcomesIn(s.comments).sort()).toEqual(["claimed", "released"]);
  });
});

/** Two hosts claim one item at once through `make`'s adapter; exactly one claims it. */
async function race(make: () => Tracker, key: string) {
  const host = () => {
    const t = make();
    return claimWithMarker(t, key, FACTS, () => claimIssue(t, key), CLOCK);
  };
  const results = await Promise.all([host(), host()]);
  return results.map((r) => r.outcome).sort();
}

describe("two hosts racing for one item", () => {
  it("on GitHub", async () => {
    const s = githubClaimStore();
    const make = () =>
      gitHub((c) => {
        if (c.op !== "TrackerIssue") return s.answer(c);
        return oneIssue(
          issueNode({
            number: 5,
            labels: s.item.labels,
            assignee: s.item.logins[0] ?? null,
            extra: { subIssues: conn([]) },
          }),
        );
      }).t;
    expect(await race(make, "#5")).toEqual(["claimed", "refused"]);
    expect(s.writes).toEqual(["TrackerAssign", "TrackerAddLabels"]);
    expect(markerIds(s.comments)).toHaveLength(1);
    expect(outcomesIn(s.comments).sort()).toEqual(["claimed", "released"]);
  });

  it("on Linear", async () => {
    const s = linearClaimStore("Todo");
    const transport: LinearTransport = async (query, variables) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      if (op !== "TrackerPoolIssue") return s.answer(op, variables);
      return {
        issue: {
          identifier: "ENG-4",
          title: "t",
          url: null,
          priority: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          state: {
            id: s.STATE_IDS[s.item.stateName],
            name: s.item.stateName,
            type: "unstarted",
          },
          assignee: s.item.assignee,
          labels: { pageInfo: { hasNextPage: false }, nodes: [] },
          children: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      };
    };
    const make = () =>
      linearTracker({ team: "ENG", states: STATES, transport });
    expect(await race(make, "ENG-4")).toEqual(["claimed", "refused"]);
    expect(s.writes).toEqual(["TrackerAssign", "TrackerUpdate"]);
    expect(markerIds(s.comments)).toHaveLength(1);
    expect(outcomesIn(s.comments).sort()).toEqual(["claimed", "released"]);
  });

  it("on Jira", async () => {
    const s = jiraClaimStore("To Do");
    const answer = (c: Call) => {
      if (c.route === "GET myself") return FACTORY;
      if (c.route === "GET issue/ENG-1")
        return jiraIssue({ key: "ENG-1", ...s.item });
      if (c.route === "POST search/jql") return page();
      return s.answer(c);
    };
    const make = () => jira(answer).t;
    expect(await race(make, "ENG-1")).toEqual(["claimed", "refused"]);
    expect(s.writes).toEqual([
      "PUT issue/ENG-1/assignee",
      "POST issue/ENG-1/transitions",
    ]);
    // Jira keeps a comment's body as a document: read it back as the claim does.
    const { comments } = await make().issueComments("ENG-1");
    expect(markerIds(comments)).toHaveLength(1);
    expect(outcomesIn(comments).sort()).toEqual(["claimed", "released"]);
  });
});

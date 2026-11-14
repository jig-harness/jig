/**
 * The `blocked` writer against the Jira adapter over a fake transport: the
 * blocked fields the transition's screen carries go with the move, so a
 * validator that requires one passes; the rest are written after it, and
 * the return move takes its transition, then clears them.
 */
import { describe, expect, test } from "bun:test";
import { type BlockedPr, projectBlocked } from "../scripts/lib/blocked-move.ts";
import { JiraApiError } from "../scripts/lib/tracker/jira/transport.ts";
import type { CommentFact } from "../scripts/lib/tracker/port.ts";
import { DEFAULT_LABELS } from "../../../shared/pr-labels/projection.ts";
import {
  type Call,
  issue,
  jira,
  page,
  routes,
  writes,
} from "./jira-fixtures.ts";

const LABELS = { ...DEFAULT_LABELS, enabled: true };
const KEYS = {
  source: "(?<!\\w)ENG-\\d+(?!\\w)",
  normalize: (k: string) => k.toUpperCase(),
};
const NOW = () => Temporal.Instant.from("2026-11-11T09:30:00Z");

const SITE_FIELDS = [
  {
    id: "customfield_1",
    name: "Blocker reason",
    schema: { type: "string", custom: "x:textarea" },
  },
  { id: "customfield_2", name: "Blocked Since", schema: { type: "datetime" } },
];

const OVERLAY = {
  issue_tracker: {
    states: { blocked: "Blocked" },
    jira: {
      blocked_fields: { reason: "Blocker reason", since: "Blocked Since" },
    },
  },
};

const parked = (projected: BlockedPr["projected"]): BlockedPr => ({
  pr: 7,
  url: "https://github.com/acme/app/pull/7",
  body: "Closes ENG-1",
  labels: ["jig:parked"],
  projected,
  stop: "2026-11-11T08:00:00Z",
  causes: [{ class: "human-decision", reason: "Run the backfill first?" }],
});

/** The transitions out of the current status, `onScreen` the field ids the move's screen carries. */
const transitionsTo = (to: string, onScreen: string[]) => ({
  transitions: [
    {
      id: "41",
      name: `to ${to}`,
      to: { id: `s-${to}`, name: to },
      fields: Object.fromEntries(
        onScreen.map((id) => [id, { required: true, name: id }]),
      ),
    },
  ],
});

/**
 * A Jira site whose move into Blocked carries `onScreen`, and whose
 * validator refuses it without `required`. Comments live in memory, as the
 * projection's marker needs them.
 */
function site(
  onScreen: string[],
  required: string | null,
  outage = false,
  siteFields: unknown = SITE_FIELDS,
) {
  const state = { status: "In Progress" };
  const comments: CommentFact[] = [];
  const { t, calls } = jira(
    routes({
      "GET field": siteFields,
      "POST search/jql": page(),
      "GET issue/ENG-1": () =>
        issue({
          key: "ENG-1",
          status: state.status,
          category: "indeterminate",
        }),
      "GET issue/ENG-1/transitions": () =>
        state.status === "Blocked"
          ? transitionsTo("In Progress", [])
          : transitionsTo("Blocked", onScreen),
      "POST issue/ENG-1/transitions": (c: Call) => {
        if (outage)
          return new JiraApiError(
            "Jira API HTTP 503 on POST issue/ENG-1/transitions: unavailable",
            { status: 503, code: "server-fault" },
          );
        const fields = (c.body.fields ?? {}) as Record<string, unknown>;
        if (state.status !== "Blocked" && required !== null)
          if (!(required in fields))
            return new JiraApiError(
              "Jira API HTTP 400 on POST issue/ENG-1/transitions: Blocker reason must be filled",
              { status: 400 },
            );
        state.status = state.status === "Blocked" ? "In Progress" : "Blocked";
        return null;
      },
      "PUT issue/ENG-1": {},
    }),
    OVERLAY,
  );
  const tracker = {
    ...t,
    async issueComments(key: string) {
      return { uuid: key, comments };
    },
    async postComment(_key: string, body: string) {
      comments.push({ body, createdAt: "2026-11-11T09:00:00Z", trusted: true });
    },
  };
  return { tracker, calls, state };
}

const moves = (calls: Call[]) =>
  calls.filter((c) => c.route === "POST issue/ENG-1/transitions");
const puts = (calls: Call[]) =>
  calls.filter((c) => c.route === "PUT issue/ENG-1");

describe("a block on Jira", () => {
  test("sends the reason with a move whose validator requires it", async () => {
    const { tracker, calls, state } = site(["customfield_1"], "customfield_1");
    const [out] = await projectBlocked(
      tracker,
      KEYS,
      LABELS,
      parked({ state: "parked" }),
      NOW,
    );
    expect(out?.outcome).toBe("blocked");
    expect(state.status).toBe("Blocked");
    const [move] = moves(calls);
    expect(move?.body.transition).toEqual({ id: "41" });
    const sent = (move?.body.fields ?? {}) as Record<string, unknown>;
    expect(sent.customfield_1).toMatchObject({ type: "doc" });
    // The start is not on the move's screen: the update after it writes it, alone.
    expect(puts(calls).map((c) => c.body)).toEqual([
      { fields: { customfield_2: "2026-11-11T09:30:00.000+0000" } },
    ]);
    expect(out?.detail).toContain("sent with the move: reason");
  });

  test("writes a field the move's screen lacks with the update after it", async () => {
    const { tracker, calls } = site([], null);
    const [out] = await projectBlocked(
      tracker,
      KEYS,
      LABELS,
      parked({ state: "parked" }),
      NOW,
    );
    expect(out?.outcome).toBe("blocked");
    expect(moves(calls).map((c) => c.body)).toEqual([
      { transition: { id: "41" } },
    ]);
    expect(writes(calls).at(-1)).toBe("PUT issue/ENG-1");
    expect(
      puts(calls).map((c) => Object.keys(c.body.fields as object)),
    ).toEqual([["customfield_1", "customfield_2"]]);
  });

  test("a refusal names the transition, Jira's message and what was sent", async () => {
    // The validator requires the start, which the screen does not carry.
    const { tracker, state } = site(["customfield_1"], "customfield_2");
    const [out] = await projectBlocked(
      tracker,
      KEYS,
      LABELS,
      parked({ state: "parked" }),
      NOW,
    );
    expect(out?.outcome).toBe("refused");
    expect(state.status).toBe("In Progress");
    expect(out?.detail).toContain("'to Blocked'");
    expect(out?.detail).toContain("Blocker reason must be filled");
    expect(out?.detail).toContain("sent with it: reason (Blocker reason)");
    expect(out?.detail).toContain("not on its screen: since (Blocked Since)");
  });

  test("an outage on the move is reported as it came, not as a refusal", async () => {
    const { tracker, state } = site(["customfield_1"], null, true);
    const [out] = await projectBlocked(
      tracker,
      KEYS,
      LABELS,
      parked({ state: "parked" }),
      NOW,
    );
    expect(out?.outcome).toBe("refused");
    expect(state.status).toBe("In Progress");
    expect(out?.detail).toBe(
      "Jira API HTTP 503 on POST issue/ENG-1/transitions: unavailable",
    );
  });

  test("a comment that does not post undoes the move and clears the fields it carried", async () => {
    const { tracker, calls, state } = site(["customfield_1"], "customfield_1");
    const failing = {
      ...tracker,
      async postComment(): Promise<void> {
        throw new Error("forbidden");
      },
    };
    const [out] = await projectBlocked(
      failing,
      KEYS,
      LABELS,
      parked({ state: "parked" }),
      NOW,
    );
    expect(out?.outcome).toBe("refused");
    expect(state.status).toBe("In Progress");
    expect(puts(calls).map((c) => c.body)).toEqual([
      { fields: { customfield_1: null } },
    ]);
    expect(out?.detail).toContain("its blocked fields cleared");
  });

  test("the return move takes its transition, then the clearing update", async () => {
    const { tracker, calls } = site(["customfield_1"], "customfield_1");
    await projectBlocked(
      tracker,
      KEYS,
      LABELS,
      parked({ state: "parked" }),
      NOW,
    );
    calls.length = 0;
    const [out] = await projectBlocked(
      tracker,
      KEYS,
      LABELS,
      parked({ state: "driving" }),
      NOW,
    );
    expect(out?.outcome).toBe("returned");
    expect(moves(calls).map((c) => c.body)).toEqual([
      { transition: { id: "41" } },
    ]);
    expect(writes(calls)).toEqual([
      "POST issue/ENG-1/transitions",
      "PUT issue/ENG-1",
    ]);
    expect(puts(calls)[0]?.body).toEqual({
      fields: { customfield_1: null, customfield_2: null },
    });
  });

  describe("clearing a field that cannot take a value", () => {
    const numeric = (id: string, name: string) => ({
      id,
      name,
      schema: { type: "number" },
    });
    const returned = async (siteFields: unknown) => {
      const { tracker, calls } = site([], null, false, siteFields);
      await projectBlocked(
        tracker,
        KEYS,
        LABELS,
        parked({ state: "parked" }),
        NOW,
      );
      calls.length = 0;
      const [out] = await projectBlocked(
        tracker,
        KEYS,
        LABELS,
        parked({ state: "driving" }),
        NOW,
      );
      return { out, calls };
    };

    test("clears the valid sibling and names the field left as it was", async () => {
      const { out, calls } = await returned([
        numeric("customfield_1", "Blocker reason"),
        SITE_FIELDS[1],
      ]);
      expect(puts(calls)[0]?.body).toEqual({
        fields: { customfield_2: null },
      });
      expect(out?.detail).toContain("not written");
      expect(out?.detail).toContain("cleared since");
      expect(out?.detail).toContain("Blocker reason");
      expect(out?.detail).not.toContain("its blocked fields cleared");
    });

    test("with every field invalid, writes nothing and reports why", async () => {
      const { out, calls } = await returned([
        numeric("customfield_1", "Blocker reason"),
        numeric("customfield_2", "Blocked Since"),
      ]);
      expect(puts(calls)).toEqual([]);
      expect(out?.detail).toContain("not written");
      expect(out?.detail).toContain("Blocked Since");
    });
  });
});

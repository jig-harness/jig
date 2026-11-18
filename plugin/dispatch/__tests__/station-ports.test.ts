/**
 * The steps the tick takes on a person's answer refuse, naming why, when a
 * fact that makes them safe no longer holds: the stage is off, the labels
 * cannot carry a re-arm, an open pull request carries the item, a session
 * holds it; and a release moves the item only when none of those stops it.
 */
import { describe, expect, it } from "bun:test";
import type {
  CommentFact,
  Tracker,
  TrackerUser,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { DEFAULT_LABELS } from "../lib/labels.ts";
import type { SessionsReport } from "../lib/runtime/port.ts";
import type { SharedContext } from "../lib/shared-launches.ts";
import { type StationInputs, stationPorts } from "../lib/station-ports.ts";
import type { DispatchSection } from "../lib/types.ts";
import type { WorkLinks } from "../lib/work-links.ts";

const FREE: SessionsReport = { ok: true, source: "test", workspaces: [] };

function inputs(fields: Partial<StationInputs> = {}): StationInputs & {
  moved: string[];
} {
  const moved: string[] = [];
  const tracker = {
    getIssue: async () => ({ state: { name: "In Progress", type: "started" } }),
    transition: async (key: string, state: string) => {
      moved.push(`${key} ${state}`);
    },
  } as unknown as Tracker;
  const links: WorkLinks = { itemsOf: () => null, prsOf: () => [] };
  return {
    moved,
    repo: {
      path: "/srv/work/web",
      slug: "example-org/web",
      defaultBranch: "main",
    },
    enabled: new Set(["pickup", "followup", "rearm"]),
    section: {
      states: ["todo"],
      labels: { ...DEFAULT_LABELS, enabled: false },
    } as unknown as DispatchSection,
    shared: {} as SharedContext,
    login: "drive-bot",
    tracker,
    issueRepository: "example-org/web",
    links,
    sessions: async () => FREE,
    ...fields,
  };
}

const reasonOf = (
  r: { ok: boolean } & ({ failure: { reason: string } } | object),
) => ("failure" in r ? r.failure.reason : null);

describe("the steps on a person's answer", () => {
  it("releases a stalled pickup's claim to the state a pickup starts from", async () => {
    const i = inputs();
    const done = await stationPorts(i).releasePickup("#513");
    expect(done).toEqual({
      ok: true,
      value: expect.stringContaining("moved #513 to todo"),
    });
    expect(i.moved).toEqual(["#513 todo"]);
  });

  it("moves nothing for an item no longer in progress, and refuses one the tracker has completed", async () => {
    const i = inputs();
    for (const [type, moves] of [
      ["unstarted", 0],
      ["completed", 0],
    ] as const) {
      (i.tracker as unknown as { getIssue: unknown }).getIssue = async () => ({
        state: { name: "x", type },
      });
      const r = await stationPorts(i).releasePickup("#513");
      expect(r.ok).toBe(type === "unstarted");
      expect(i.moved.length).toBe(moves);
    }
  });

  it("refuses to detach a checkout whose launch stage is off", async () => {
    const r = await stationPorts(
      inputs({ enabled: new Set(["followup"]) }),
    ).detachCheckout("#513", "513", "/srv/work/web-513", "pickup");
    expect(reasonOf(r)).toContain("the pickup stage is off");
  });

  it("refuses a release the stage, a carrying pull request, an unread link or a session stops, moving nothing", async () => {
    const cases: Array<[Partial<StationInputs>, string]> = [
      [{ enabled: new Set(["followup"]) }, "the pickup stage is off"],
      [
        {
          links: {
            itemsOf: () => null,
            prsOf: () => [{ number: 793, url: "u" }],
          },
        },
        "open pull request #793 carries #513",
      ],
      [{ links: null }, "cannot be told this tick"],
      [
        {
          sessions: async () => ({
            ok: true,
            source: "test",
            workspaces: [
              {
                id: "w",
                path: "/srv/work/web-513",
                branch: "513",
                items: ["#513"],
                prs: [],
                agents: [
                  {
                    id: "a",
                    state: "working",
                    agentType: "claude",
                    since: null,
                  },
                ],
                unverifiableTerminals: 0,
                comment: "",
                unread: false,
                name: "",
              },
            ],
          }),
        },
        "a session holds #513",
      ],
      [{ tracker: null }, "the issue service did not open"],
    ];
    for (const [fields, says] of cases) {
      const i = inputs(fields);
      const refused = await stationPorts(i).releasePickup("#513");
      expect(reasonOf(refused)).toContain(says);
      expect(i.moved).toEqual([]);
    }
  });

  it("refuses a re-arm with the stage off or the labels off, and a follow-up step with its stage off", async () => {
    expect(
      reasonOf(
        await stationPorts(inputs({ enabled: new Set() })).rearmDrive(7),
      ),
    ).toContain("the rearm stage is off");
    expect(reasonOf(await stationPorts(inputs()).rearmDrive(7))).toContain(
      "dispatch labels off",
    );
    const off = stationPorts(inputs({ enabled: new Set(["pickup"]) }));
    expect(reasonOf(await off.rerunFollowup(12, 41))).toContain(
      "the followup stage is off",
    );
    expect(reasonOf(await off.doneFollowup(12, 41))).toContain(
      "the followup stage is off",
    );
  });
});

describe("the answers on an item of another tracker", () => {
  const FACTORY = { id: "u-factory", name: "Jig Factory" };
  const DANA = { id: "u-dana", name: "Dana Lee" };
  const fact = (
    body: string,
    author: TrackerUser | null,
    fields: Partial<CommentFact> = {},
  ): CommentFact => ({
    id: `c-${body.length}-${author?.id ?? "none"}`,
    body,
    createdAt: "2026-11-12T11:00:00.000Z",
    trusted: author !== null,
    author,
    ...fields,
  });

  /** A Linear-like tracker holding `comments` on every item, counting its reads. */
  function onTracker(
    comments: CommentFact[] | Error,
    fields: Partial<Tracker> = {},
  ): { tracker: Tracker; reads: string[] } {
    const reads: string[] = [];
    const tracker = {
      adapter: "linear",
      commentAuthors: true,
      viewer: async () => {
        reads.push("viewer");
        return FACTORY;
      },
      issueComments: async (key: string) => {
        reads.push(key);
        if (comments instanceof Error) throw comments;
        return { uuid: "uuid-1", comments };
      },
      ...fields,
    } as unknown as Tracker;
    return { tracker, reads };
  }

  it("names each author, counts a member's comment trusted, and keeps the tracker's own user's apart", async () => {
    const { tracker, reads } = onTracker([
      // The tracker's own user is no member (a guest), yet its answer is still detected.
      fact("answer pickup: approve [d1]", FACTORY, { trusted: false }),
      fact("answer pickup: approve \\[0123456789ab\\]", DANA, {
        url: "https://linear.app/acme/issue/ENG-12/x#comment-7",
        editedAt: "2026-11-12T12:00:00.000Z",
      }),
      fact(
        "answer pickup: approve",
        { id: "u-guest", name: "Guest" },
        {
          trusted: false,
          id: "c-guest",
        },
      ),
      fact("an integration wrote this", null, { id: "c-bot" }),
    ]);
    const ports = stationPorts(inputs({ tracker }));
    const read = await ports.trackerComments("ENG-12");
    expect(read).toEqual({
      ok: true,
      value: {
        own: {
          name: "Jig Factory",
          comments: [
            {
              author: "Jig Factory",
              association: "MEMBER",
              at: "2026-11-12T11:00:00.000Z",
              editedAt: null,
              url: `ENG-12#comment-c-27-u-factory`,
              body: "answer pickup: approve [d1]",
            },
          ],
        },
        comments: [
          {
            author: "Dana Lee",
            association: "MEMBER",
            at: "2026-11-12T11:00:00.000Z",
            editedAt: "2026-11-12T12:00:00.000Z",
            url: "https://linear.app/acme/issue/ENG-12/x#comment-7",
            body: "answer pickup: approve [0123456789ab]",
          },
          {
            author: "Guest",
            association: "NONE",
            at: "2026-11-12T11:00:00.000Z",
            editedAt: null,
            url: "ENG-12#comment-c-guest",
            body: "answer pickup: approve",
          },
          {
            author: "",
            association: "NONE",
            at: "2026-11-12T11:00:00.000Z",
            editedAt: null,
            url: "ENG-12#comment-c-bot",
            body: "an integration wrote this",
          },
        ],
      },
    });
    await ports.trackerComments("ENG-13");
    // The tracker's own user is asked once a tick.
    expect(reads).toEqual(["viewer", "ENG-12", "ENG-13"]);
  });

  it("hands the identity read a signal, and asks again after a read that failed", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const { tracker } = onTracker([], {
      viewer: async (signal?: AbortSignal) => {
        signals.push(signal);
        if (signals.length === 1) throw new Error("cancelled");
        return FACTORY;
      },
    });
    const ports = stationPorts(inputs({ tracker }));
    expect((await ports.trackerComments("ENG-12")).ok).toBe(false);
    expect((await ports.trackerComments("ENG-13")).ok).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("tells two people of one name apart, so neither's answer replaces the other's", async () => {
    const { tracker } = onTracker([
      fact("answer pickup: approve", { id: "u-sam-1", name: "Sam" }),
      fact("answer pickup: approve", { id: "u-sam-2", name: "Sam" }),
    ]);
    const read = await stationPorts(inputs({ tracker })).trackerComments(
      "ENG-12",
    );
    expect(read.ok && read.value.comments.map((c) => c.author)).toEqual([
      "Sam (u-sam-1)",
      "Sam (u-sam-2)",
    ]);
  });

  it("keeps a label apart when a user's real name spells another user's label", async () => {
    const { tracker } = onTracker([
      fact("answer pickup: approve", { id: "u1", name: "Sam" }),
      fact("answer pickup: approve", { id: "u2", name: "Sam" }),
      fact("answer pickup: approve", { id: "u3", name: "Sam (u1)" }),
    ]);
    const read = await stationPorts(inputs({ tracker })).trackerComments(
      "ENG-12",
    );
    const labels = read.ok
      ? read.value.comments.map((c) => c.author.toLowerCase())
      : [];
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
  });

  it("does not read a tracker that cannot name who wrote a comment, one that did not open, or one that fails, and says why", async () => {
    const cases: Array<[Tracker | null, string]> = [
      [
        onTracker([], { commentAuthors: false }).tracker,
        "the linear tracker does not name who wrote each comment, so answers on ENG-12 cannot be told apart and are not read",
      ],
      [null, "the tracker did not open this tick"],
      [onTracker(new Error("HTTP 503")).tracker, "HTTP 503"],
      [
        onTracker([], {
          viewer: async () => Promise.reject(new Error("no viewer")),
        }).tracker,
        "the user the tracker's credential acts as did not read",
      ],
    ];
    for (const [tracker, says] of cases) {
      const read = await stationPorts(inputs({ tracker })).trackerComments(
        "ENG-12",
      );
      expect(read.ok).toBe(false);
      expect(reasonOf(read)).toContain(says);
    }
  });
});

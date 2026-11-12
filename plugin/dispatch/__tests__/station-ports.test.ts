/**
 * The steps the tick takes on a person's answer refuse, naming why, when a
 * fact that makes them safe no longer holds: the stage is off, the labels
 * cannot carry a re-arm, an open pull request carries the item, a session
 * holds it; and a release moves the item only when none of those stops it.
 */
import { describe, expect, it } from "bun:test";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
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
      [{ tracker: null }, "the tracker did not open"],
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

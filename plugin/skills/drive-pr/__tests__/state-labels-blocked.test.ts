/**
 * drive-pr: the drive's own state label write carries the projection's
 * tracker output. A stop with only parked work left moves the items the pull
 * request links to `blocked`, with each park's class and reason; the arm
 * returns them to the state they left. A repository whose labels are off,
 * or whose tracker names no `blocked` state, gets no tracker call.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  type ItemTracker,
  type LabelSource,
  labelDrive,
} from "../scripts/lib/driver/state-labels.ts";
import { ok } from "../../../shared/outcome.ts";
import type { CanonicalState } from "../../do-item/scripts/lib/tracker/port.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";

const restore: Array<() => void> = [];
afterEach(() => {
  for (const r of restore.splice(0)) r();
});

function quiet(): string[] {
  const said: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
    said.push(String(line));
  });
  restore.push(() => spy.mockRestore());
  return said;
}

const NAMES: Partial<Record<CanonicalState, string>> = {
  in_progress: "In Progress",
  blocked: "Blocked",
  todo: "To Do",
};

/** An item store holding ENG-1, and the calls made on it. */
function items(state: string) {
  const at = { state, comments: [] as string[], calls: [] as string[] };
  const tracker: ItemTracker = {
    keys: {
      source: "(?<!\\w)ENG-\\d+(?!\\w)",
      normalize: (k: string) => k.toUpperCase(),
    },
    stateName: ((s: CanonicalState) => NAMES[s] ?? null) as never,
    getIssue: async () => {
      at.calls.push("get");
      return { state: { name: at.state, type: "started" } } as never;
    },
    issueComments: async () => ({
      uuid: "ENG-1",
      comments: at.comments.map((body) => ({
        body,
        createdAt: "2026-11-11T09:00:00Z",
        trusted: true,
      })),
    }),
    transition: async (_key, s) => {
      at.calls.push(`move ${s}`);
      at.state = NAMES[s] as string;
    },
    postComment: async (_key, body) => {
      at.comments.push(body);
    },
  };
  return { at, tracker };
}

function source(
  tracker: ItemTracker | null,
  enabled = true,
  labels: string[] = [],
): LabelSource {
  return {
    settings: async () =>
      ok({
        slug: "example/project",
        config: { enabled, prefix: "jig:", onlyLabeled: false },
      }),
    forge: () => ({
      labels: async () => ok({ labels }),
      edit: async () => ok(undefined),
    }),
    items: () => tracker,
    pullRequest: async () => ok({ body: "Closes ENG-1", labels, url: null }),
  };
}

const PARKED = {
  stopped: DRIVE_EXIT.HITL_PARKED,
  byPerson: false,
  verifiedSha: "abc",
  stop: "2026-11-11T08:00:00Z",
  parks: [
    {
      class: "scope",
      reason: "Ship the import without the export?",
    },
  ],
};

describe("the drive's blocked output", () => {
  it("a park blocks the linked item with the park's class and reason, and the arm returns it", async () => {
    const said = quiet();
    const { at, tracker } = items("In Progress");
    await labelDrive("7", PARKED, source(tracker));
    expect(at.state).toBe("Blocked");
    expect(at.comments[0]).toContain(
      "`scope`: Ship the import without the export?",
    );
    expect(said.join("\n")).toContain(
      "PR #7's item ENG-1 moved from In Progress to blocked",
    );
    await labelDrive("7", { armed: true }, source(tracker));
    expect(at.state).toBe("In Progress");
  });

  it("a person's stop with no park blocks with the stop's own cause", async () => {
    quiet();
    const { at, tracker } = items("To Do");
    await labelDrive(
      "7",
      { stopped: 0, byPerson: true, verifiedSha: "", stop: "s1" },
      source(tracker),
    );
    expect(at.state).toBe("Blocked");
    expect(at.comments[0]).toContain(
      "`stopped-by-person`: a person stopped the drive",
    );
  });

  it("labels off, no blocked state, or a hold label: no tracker call", async () => {
    quiet();
    const off = items("In Progress");
    await labelDrive("7", PARKED, source(off.tracker, false));
    expect(off.at.calls).toEqual([]);
    await labelDrive("7", PARKED, source(null));
    const held = items("In Progress");
    await labelDrive("7", PARKED, source(held.tracker, true, ["jig:hold"]));
    expect(held.at.calls).toEqual([]);
    expect(held.at.state).toBe("In Progress");
  });
});

/**
 * An admitted pickup carries what the queue read held for it: the relations
 * and parent the ranking needs for its parentage, never only the pool form.
 */
import { describe, expect, it } from "bun:test";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  type Candidate,
  finishAdmission,
} from "../lib/sources/served-admission.ts";
import type { ServedOptions, ServedReading } from "../lib/sources/served.ts";

function pool(identifier: string): PoolIssue {
  return {
    identifier,
    title: identifier,
    url: `https://forge.example/${identifier}`,
    state: { id: "s", name: "Todo", type: "unstarted" },
    labels: [],
    priority: 3,
    type: null,
    isEpic: false,
    hasOpenChildren: false,
    assignee: "writer",
  } as unknown as PoolIssue;
}

function admit(candidate: Candidate) {
  const out = { wanted: [], unplaced: [] } as unknown as ServedReading;
  finishAdmission([candidate], { walks: [] }, out, {} as ServedOptions);
  return out.wanted[0]?.queueIssue;
}

describe("finishAdmission", () => {
  const base = { identity: "writer", by: "writer", blockers: [], unblocks: 0 };
  it("hands the queue read's parent and relations to the pickup", () => {
    const parent = { issue: pool("#9"), description: "", parent: null };
    const queued = admit({
      ...base,
      issue: pool("#3"),
      queueRead: { relations: [], parent },
    });
    expect(queued).toMatchObject({ relations: [], parent });
  });
  it("hands the pool form alone where the read carried no parent", () => {
    const queued = admit({ ...base, issue: pool("#3") });
    expect(queued).not.toHaveProperty("parent");
  });
});

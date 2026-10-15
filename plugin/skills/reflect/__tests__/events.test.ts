/**
 * The event model, computed state, settings and context helpers, without
 * spawning anything.
 */
import { describe, expect, it } from "bun:test";
import {
  detectHarness,
  issueFromBranch,
  normalizeRemote,
  pendingDir,
} from "../scripts/lib/context.ts";
import {
  computeState,
  type DecisionEvent,
  decisionStamp,
  derivedId,
  distinctById,
  eventProblems,
  eventText,
  type FindingEvent,
  highestSeverity,
  idConflicts,
  newId,
  ownerOf,
  parseEvent,
  recurrence,
} from "../scripts/lib/events.ts";
import { parseReflection, splitWords } from "../scripts/lib/settings.ts";
import { sampleFinding } from "../scripts/store-contract.ts";

function decision(
  finding: string,
  kind: DecisionEvent["decision"],
  at: string,
  id = newId(at),
): DecisionEvent {
  return {
    v: 1,
    type: "decision",
    id,
    at,
    session: sampleFinding(newId(), "x").session,
    finding,
    decision: kind,
    reason: "because",
    ...(kind === "escalated" ? { issue: "ENG-1" } : {}),
  };
}

function inRepository(
  id: string,
  repository: string,
  className = "c",
): FindingEvent {
  const f = sampleFinding(id, `finding ${id}`);
  return {
    ...f,
    class: className,
    change: { ...f.change, repository },
    target: { scope: "repository", name: "AGENTS.md" },
  };
}

describe("events", () => {
  it("accepts a complete finding and names every problem of a broken one", () => {
    const good = sampleFinding(newId(), "fine");
    expect(eventProblems(good)).toEqual([]);
    expect(parseEvent(eventText(good))).toEqual(good);
    const broken = {
      ...good,
      class: "Not Kebab",
      severity: "urgent",
      title: "",
    };
    expect(eventProblems(broken)).toEqual([
      "severity must be one of high, medium, low",
      "class must be a kebab-case name such as narrow-fix-per-round",
      "title is required",
    ]);
    expect(() => parseEvent("not json")).toThrow("not JSON");
  });

  it("takes only a real instant, written the one way times sort", () => {
    const good = sampleFinding(newId(), "fine");
    const problem = "at must be a UTC time such as 2026-10-12T15:04:05Z";
    for (const at of [
      "2026-99-99T99:99:99Z",
      "2026-02-30T12:00:00Z",
      "2026-10-12T24:00:00Z",
    ])
      expect(eventProblems({ ...good, at })).toContain(problem);
    expect(eventProblems({ ...good, at: "2028-02-29T23:59:59Z" })).toEqual([]);
  });

  it("requires an issue on an escalated decision, and a reason on every one", () => {
    const d = decision(newId(), "escalated", "2026-10-12T10:00:00Z");
    expect(eventProblems(d)).toEqual([]);
    const { issue: _issue, ...withoutIssue } = d;
    expect(eventProblems(withoutIssue)).toContain(
      "an escalated decision names its issue",
    );
    expect(eventProblems({ ...d, reason: " " })).toContain(
      "reason is required",
    );
  });

  it("makes time-ordered random ids, and derived ids that repeat for one fact", () => {
    const id = newId("2026-10-12T15:04:05Z");
    expect(id).toMatch(/^20261012T150405Z-[0-9a-f]{16}$/);
    expect(newId("2026-10-12T15:04:05Z")).not.toBe(id);
    expect(derivedId(["repo", "pr-1", "rounds"])).toBe(
      derivedId(["repo", "pr-1", "rounds"]),
    );
    expect(derivedId(["repo", "pr-1"])).not.toBe(derivedId(["repo", "pr-2"]));
  });

  it("orders a new decision after the latest, taking the next second when its ids run out", () => {
    const latest = {
      at: "2026-10-12T15:04:05Z",
      id: "20261012T150405Z-00000000000000ff",
    };
    const same = decisionStamp(latest, "2026-10-12T15:04:05Z");
    expect(same.at).toBe(latest.at);
    expect(same.id > latest.id).toBe(true);
    const full = { ...latest, id: "20261012T150405Z-ffffffffffffffff" };
    const next = decisionStamp(full, "2026-10-12T15:04:00Z");
    expect(next.at).toBe("2026-10-12T15:04:06Z");
    expect(next.id).toMatch(/^20261012T150406Z-[0-9a-f]{16}$/);
  });

  it("returns each id once, settling a conflict to the text that sorts first", () => {
    const a = sampleFinding(newId(), "alpha");
    const b = { ...a, title: "beta" };
    const copies = [
      { event: b, text: eventText(b) },
      { event: a, text: eventText(a) },
      { event: b, text: eventText(b) },
    ];
    const once = distinctById(copies);
    expect(once).toHaveLength(1);
    expect(once[0]?.text).toBe(
      eventText(a) < eventText(b) ? eventText(a) : eventText(b),
    );
    const conflicts = idConflicts(
      copies.map((copy) => ({ ...copy, id: copy.event.id })),
    );
    expect(conflicts.get(a.id)).toHaveLength(2);
  });
});

describe("computed state", () => {
  it("takes the latest decision by time, then by id, whatever order the events come in", () => {
    const f = inRepository(newId(), "github.com/example/web");
    const sameSecond = "2026-10-13T09:00:00Z";
    const low = decision(
      f.id,
      "deferred",
      sameSecond,
      "20261013T090000Z-0000000000000001",
    );
    const high = decision(
      f.id,
      "dismissed",
      sameSecond,
      "20261013T090000Z-0000000000000002",
    );
    const early = decision(f.id, "approved", "2026-10-12T09:00:00Z");
    for (const order of [
      [f, low, high, early],
      [early, high, f, low],
    ])
      expect(computeState(order).findings.get(f.id)?.status).toBe("dismissed");
    expect(computeState([f]).findings.get(f.id)?.status).toBe("open");
  });

  it("owns a repository finding by its repository and a tool finding by its tool", () => {
    const repoFinding = inRepository(newId(), "github.com/example/web");
    expect(ownerOf(repoFinding)).toBe("repository:github.com/example/web");
    expect(ownerOf(sampleFinding(newId(), "t"))).toBe("tool:jig");
  });

  it("counts a class's recurrence per owner, over open and deferred findings", () => {
    const web = "github.com/example/web";
    const api = "github.com/example/api";
    const f1 = inRepository(newId(), web);
    const f2 = inRepository(newId(), web);
    const f3 = inRepository(newId(), web);
    const other = inRepository(newId(), api);
    const state = computeState([
      f1,
      f2,
      f3,
      other,
      decision(f2.id, "deferred", "2026-10-13T00:00:00Z"),
      decision(f3.id, "dismissed", "2026-10-13T00:00:00Z"),
    ]);
    expect(recurrence(state, `repository:${web}`, "c")).toBe(2);
    expect(recurrence(state, `repository:${api}`, "c")).toBe(1);
  });

  it("reports the highest severity", () => {
    expect(highestSeverity(["low", "high", "medium"])).toBe("high");
    expect(highestSeverity([])).toBeNull();
  });
});

describe("settings", () => {
  it("is off without the section, and when it says enabled: false", () => {
    expect(parseReflection(undefined, "/repo").on).toBe(false);
    expect(
      parseReflection({ enabled: false, store: "filesystem" }, "/repo").on,
    ).toBe(false);
    // Parking still has to find a configured journal.
    expect(
      parseReflection({ enabled: false, journal: "scratch/j.jsonl" }, "/repo"),
    ).toEqual({ on: false, journal: "/repo/scratch/j.jsonl" });
  });

  it("fills the defaults when the section is present", () => {
    const settings = parseReflection({}, "/repo");
    expect(settings).toMatchObject({
      on: true,
      store: "filesystem",
      escalateAfter: 3,
      timeoutSec: 120,
      mode: "quick",
      journal: null,
    });
  });

  it("refuses an unknown field, a command store without a command, and a bad number", () => {
    expect(() => parseReflection({ stor: "filesystem" }, "/repo")).toThrow(
      "reflection.stor is not a reflection setting",
    );
    expect(() => parseReflection({ store: "command" }, "/repo")).toThrow(
      "reflection.command is required",
    );
    expect(() => parseReflection({ escalate_after: 0 }, "/repo")).toThrow(
      "reflection.escalate_after must be a whole number",
    );
    // Five times the deadline must still fit a timer.
    expect(() => parseReflection({ timeout_sec: 429_497 }, "/repo")).toThrow(
      "reflection.timeout_sec must be at most 86400",
    );
  });

  it("reads the Notion store's database from an id or a link", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const dashed = "01234567-89ab-cdef-0123-456789abcdef";
    expect(
      parseReflection({ store: "notion", notion: { database: id } }, "/repo"),
    ).toMatchObject({ store: "notion", notionDatabase: dashed });
    expect(
      parseReflection(
        {
          store: "notion",
          notion: {
            database: `https://www.notion.so/team/Agent-reflections-${id}?v=fedcba9876543210fedcba9876543210`,
          },
        },
        "/repo",
      ),
    ).toMatchObject({ notionDatabase: dashed });
    expect(() => parseReflection({ store: "notion" }, "/repo")).toThrow(
      "reflection.notion.database is required",
    );
    expect(() =>
      parseReflection(
        { store: "notion", notion: { database: "not an id" } },
        "/repo",
      ),
    ).toThrow("must be a Notion database id or link");
    expect(() =>
      parseReflection(
        { store: "notion", notion: { database: id, token: "x" } },
        "/repo",
      ),
    ).toThrow("reflection.notion.token is not a Notion store setting");
  });

  it("splits a command line without a shell", () => {
    expect(splitWords(`bun "my store.ts" --path '/a b' x`)).toEqual([
      "bun",
      "my store.ts",
      "--path",
      "/a b",
      "x",
    ]);
    expect(() => splitWords(`bun "open`)).toThrow("unclosed");
  });
});

describe("context", () => {
  it("names a repository the same from every kind of remote", () => {
    for (const url of [
      "git@github.com:Example/web.git",
      "https://github.com/example/web.git",
      "https://user:token@github.com/example/web",
      "ssh://git@github.com:22/example/web.git",
    ])
      expect(normalizeRemote(url)).toBe("github.com/example/web");
  });

  it("keeps the pending folders of repositories that read alike apart", () => {
    expect(pendingDir("github.com/a/b_c")).not.toBe(
      pendingDir("github.com/a_b/c"),
    );
    expect(pendingDir("github.com/a/b_c")).toBe(pendingDir("github.com/a/b_c"));
  });

  it("reads the issue key a branch carries", () => {
    expect(issueFromBranch("feature/eng-12-retry", "ENG")).toBe("ENG-12");
    expect(issueFromBranch("feature/eng-12-retry", null)).toBeNull();
    expect(issueFromBranch("feature/meng-12", "ENG")).toBeNull();
  });

  it("detects the harness and its wrapper from their variables", () => {
    expect(
      detectHarness({
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CONDUCTOR_PORT: "1",
      }),
    ).toEqual({
      name: "claude-code",
      version: null,
      entrypoint: "cli",
      wrapper: "conductor",
    });
    expect(detectHarness({ PATH: "/bin" })).toBeNull();
  });
});

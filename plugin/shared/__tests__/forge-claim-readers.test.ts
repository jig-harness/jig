/**
 * What the readers of the takeover claim, the launch claim and the
 * merge-ready announcement accept and refuse, each with the reason a refusal
 * gives: every form the writers write or wrote before (the takeover claim
 * without the envelope, the announcement that only ends with its head
 * marker), every optional field present and absent, and each way a field can
 * break. The readers validate against the shape descriptions the Protocol's
 * schemas are generated from (`records/forge-claim-shapes.ts`); these cases
 * pin what each reader accepts and the reason each refusal gives.
 */
import { describe, expect, it } from "bun:test";
import { claimBody, readClaim } from "../records/forge-claims.ts";
import {
  endedClaim,
  LAUNCH_CLAIM,
  launchClaim,
  saysOf,
} from "../records/launch-claims.ts";
import type { LaunchDraft } from "../records/shared.ts";
import {
  CLAIM_MARKER,
  renderClaim,
  TAKEOVER_CLAIM,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import {
  MERGE_READY,
  OPENER,
} from "../../skills/drive-pr/scripts/lib/announce.ts";

const WRITER = { host: "sha256:0123456789abcdef" };
const AT = "2026-11-05T09:00:00.000Z";
const TARGET = { repo: "example/repo", number: 12 };
const RECORD = "20261105T090000Z-aaaaaaaa";
const HOST = "sha256:aaaaaaaaaaaaaaaa";

/** What a body reads as: `reads`, the reason it is refused, or `null` when it is no claim of the kind. */
function verdict(
  kind: typeof LAUNCH_CLAIM,
  body: string,
  target: typeof TARGET | null = TARGET,
): string | null {
  const read = readClaim(kind, body, target);
  if (read === null) return null;
  return read.ok ? "reads" : read.failure.reason;
}

// ------------------------------------------------------------------- launch

const BASE = {
  pr: 12,
  action: "rearm",
  record: RECORD,
  host: HOST,
  facts: "generation 3, exit 16",
};

function launchBody(
  payload: Record<string, unknown>,
  generation: number | null = 1,
): string {
  return claimBody(LAUNCH_CLAIM, {
    key: "drive",
    ...(generation === null ? {} : { generation }),
    writer: WRITER,
    at: AT,
    payload,
    text: "jig dispatch launch",
  });
}

const ENDED = { state: "ended", at: AT, exit: 0, outcome: null };
const DIED = { state: "died", at: AT, reason: "the session died" };

describe("the launch claim's reader", () => {
  it("reads every form its writers write, each optional field present or absent", () => {
    const draft: LaunchDraft = {
      stage: "drive",
      pr: 12,
      run: "tick",
      action: "rearm",
      record: RECORD,
      host: HOST,
      owner: null,
      facts: null,
      writer: WRITER,
    };
    const posted = launchClaim(draft, 1, AT);
    const full = launchClaim(
      {
        ...draft,
        action: "takeover",
        owner: false,
        facts: "f",
        change: "c",
        earlier: ["a", "b"],
        conflictStop: true,
      },
      2,
      AT,
    );
    const record = {
      key: "drive",
      generation: 1,
      at: AT,
      writer: WRITER,
      payload: posted.payload,
      legacy: false,
    };
    for (const d of [
      posted,
      full,
      endedClaim("drive", record, 12, ENDED as never, WRITER),
      endedClaim(
        "drive",
        record,
        12,
        {
          state: "ended",
          at: AT,
          exit: null,
          outcome: "failed",
          by: "agent",
          cause: "needs-person",
        },
        WRITER,
      ),
      endedClaim(
        "drive",
        record,
        12,
        { ...DIED, executed: false } as never,
        WRITER,
      ),
    ])
      expect(verdict(LAUNCH_CLAIM, claimBody(LAUNCH_CLAIM, d))).toBe("reads");
  });

  const accepted: Record<string, Record<string, unknown>> = {
    "empty facts": { ...BASE, facts: "" },
    takeover: { ...BASE, action: "takeover" },
    "owner true": { ...BASE, owner: true },
    "owner false": { ...BASE, owner: false },
    change: { ...BASE, change: "the change" },
    "earlier changes": { ...BASE, earlier: ["a", "b"] },
    "no earlier changes": { ...BASE, earlier: [] },
    "a conflict stop": { ...BASE, conflictStop: true },
    "a conflict stop that is not a flag": { ...BASE, conflictStop: "yes" },
    "a field it does not know": { ...BASE, future: { any: 1 } },
    "an ended end": { ...BASE, end: ENDED },
    "an ended end on a signal": { ...BASE, end: { ...ENDED, exit: null } },
    "an ended end with a negative exit": {
      ...BASE,
      end: { ...ENDED, exit: -1 },
    },
    "an ended end with no outcome": {
      ...BASE,
      end: { state: "ended", at: AT, exit: 3 },
    },
    "an ended end done": { ...BASE, end: { ...ENDED, outcome: "done" } },
    "an ended end failed": { ...BASE, end: { ...ENDED, outcome: "failed" } },
    "an ended end with its report": {
      ...BASE,
      end: { ...ENDED, by: "agent", cause: "needs-person" },
    },
    "an ended end with a report it does not know": {
      ...BASE,
      end: { ...ENDED, by: 5, cause: "unheard-of" },
    },
    "a died end": { ...BASE, end: DIED },
    "a died end that never executed": {
      ...BASE,
      end: { ...DIED, executed: false },
    },
  };
  for (const [name, payload] of Object.entries(accepted))
    it(`reads a claim with ${name}`, () => {
      expect(verdict(LAUNCH_CLAIM, launchBody(payload))).toBe("reads");
    });

  const refused: Record<string, [Record<string, unknown>, string]> = {
    "an action it does not know": [
      { ...BASE, action: "arm" },
      "its action is neither a re-arm nor a takeover",
    ],
    "no action": [
      { ...BASE, action: undefined },
      "its action is neither a re-arm nor a takeover",
    ],
    "a launch record of another shape": [
      { ...BASE, record: "record" },
      "it names no launch record",
    ],
    "an empty host": [{ ...BASE, host: "" }, "it names no host"],
    "a host that is not text": [{ ...BASE, host: 5 }, "it names no host"],
    "no facts": [{ ...BASE, facts: undefined }, "it names no ledger facts"],
    "a change that is null": [
      { ...BASE, change: null },
      "its change is not text",
    ],
    "earlier changes that are not all text": [
      { ...BASE, earlier: ["a", 1] },
      "its earlier changes are not a list of text",
    ],
    "earlier changes that are not a list": [
      { ...BASE, earlier: "a" },
      "its earlier changes are not a list of text",
    ],
    "an owner that is null": [
      { ...BASE, owner: null },
      "its owner is neither true nor false",
    ],
    "an owner that is text": [
      { ...BASE, owner: "true" },
      "its owner is neither true nor false",
    ],
    "an end that is null": [{ ...BASE, end: null }, "its end has no time"],
    "an end that is a list": [{ ...BASE, end: [] }, "its end has no time"],
    "an end with no time": [
      { ...BASE, end: { state: "ended", exit: 0 } },
      "its end has no time",
    ],
    "an end whose time is not text": [
      { ...BASE, end: { ...ENDED, at: 5 } },
      "its end has no time",
    ],
    "a died end with no reason": [
      { ...BASE, end: { state: "died", at: AT } },
      "its end reason or execution evidence does not read",
    ],
    "a died end that executed": [
      { ...BASE, end: { ...DIED, executed: true } },
      "its end reason or execution evidence does not read",
    ],
    "an ended end whose exit is text": [
      { ...BASE, end: { ...ENDED, exit: "0" } },
      "its end's exit or outcome does not read",
    ],
    "an ended end whose exit is a fraction": [
      { ...BASE, end: { ...ENDED, exit: 1.5 } },
      "its end's exit or outcome does not read",
    ],
    "an ended end whose exit is past a safe integer": [
      { ...BASE, end: { ...ENDED, exit: 2 ** 53 } },
      "its end's exit or outcome does not read",
    ],
    "an ended end with no exit": [
      { ...BASE, end: { state: "ended", at: AT, outcome: "done" } },
      "its end's exit or outcome does not read",
    ],
    "an ended end with a manual run's outcome": [
      { ...BASE, end: { ...ENDED, outcome: "running" } },
      "its end's exit or outcome does not read",
    ],
    "an end neither ended nor died": [
      { ...BASE, end: { ...ENDED, state: "running" } },
      "its end is neither ended nor died",
    ],
    "another pull request": [
      { ...BASE, pr: 13 },
      "its record names pull request #13",
    ],
    "no pull request": [
      { ...BASE, pr: undefined },
      "its record names pull request #undefined",
    ],
    "several faults, the first in the reader's order": [
      { ...BASE, action: "arm", host: "", end: null },
      "its action is neither a re-arm nor a takeover",
    ],
    "a later field's fault and a broken end": [
      { ...BASE, owner: 1, end: null },
      "its owner is neither true nor false",
    ],
  };
  for (const [name, [payload, reason]] of Object.entries(refused))
    it(`refuses a claim with ${name}`, () => {
      const kept = Object.fromEntries(
        Object.entries(payload).filter(([, v]) => v !== undefined),
      );
      expect(verdict(LAUNCH_CLAIM, launchBody(kept))).toBe(reason);
    });

  it("refuses a claim that names no attempt, or attempt 0", () => {
    for (const generation of [null, 0])
      expect(verdict(LAUNCH_CLAIM, launchBody(BASE, generation))).toBe(
        "its record names no attempt",
      );
  });

  it("reads a claim on another pull request when no pull request is given", () => {
    const { pr: _pr, ...noPr } = BASE;
    expect(verdict(LAUNCH_CLAIM, launchBody(noPr), null)).toBe("reads");
    expect(verdict(LAUNCH_CLAIM, launchBody({ ...BASE, pr: 13 }), null)).toBe(
      "reads",
    );
  });

  it("reads an end's report only where it names a known writer and cause", () => {
    const read = readClaim(
      LAUNCH_CLAIM,
      launchBody({ ...BASE, end: { ...ENDED, by: 5, cause: "needs-person" } }),
      TARGET,
    );
    if (read === null || !read.ok) throw new Error("the claim does not read");
    expect(saysOf("drive", read.value, 12).end).toEqual({
      state: "ended",
      at: AT,
      exit: 0,
      outcome: null,
      cause: "needs-person",
    });
  });
});

// ----------------------------------------------------------------- takeover

function takeoverBody(
  payload: Record<string, unknown>,
  key: string,
  generation: number | null,
): string {
  return claimBody(TAKEOVER_CLAIM, {
    key,
    ...(generation === null ? {} : { generation }),
    writer: WRITER,
    at: AT,
    payload,
    text: "a claim",
  });
}

/** A claim written before claims carried the envelope: its data block holds the claim alone. */
function legacyTakeover(data: string): string {
  return [
    CLAIM_MARKER,
    "**Drive claim** · `drive-pr-takeover-claim` · an older driver's claim.",
    "",
    "<!-- drive-pr-takeover-claim-data",
    data,
    "-->",
    "",
  ].join("\n");
}

const LEGACY = {
  actor: "wt-cccccccccccccccc",
  clone: "clone-c",
  generation: 4,
  at: "2026-10-01T12:00:00.000Z",
};
const NOT_A_CLAIM = "it does not read as a drive-takeover-claim claim";

describe("the takeover claim's reader", () => {
  it("reads the claim its writer writes, and one naming an empty actor and clone", () => {
    const body = renderClaim(
      { actor: "wt-bbbbbbbbbbbbbbbb", clone: "clone-b", generation: 4, at: AT },
      WRITER,
    );
    expect(verdict(TAKEOVER_CLAIM, body)).toBe("reads");
    expect(
      verdict(
        TAKEOVER_CLAIM,
        takeoverBody({ actor: "", clone: "", extra: 1 }, "takeover:4", 4),
      ),
    ).toBe("reads");
  });

  it("refuses a claim that names no actor and clone, each with its reason", () => {
    for (const payload of [
      { actor: "a" },
      { clone: "c" },
      { actor: 5, clone: "c" },
      { actor: "a", clone: null },
    ])
      expect(
        verdict(TAKEOVER_CLAIM, takeoverBody(payload, "takeover:4", 4)),
      ).toBe("it names no actor and clone");
  });

  it("refuses a claim whose key is not its generation's, or that names no generation", () => {
    const payload = { actor: "a", clone: "c" };
    expect(
      verdict(TAKEOVER_CLAIM, takeoverBody(payload, "takeover:4", 3)),
    ).toBe("its key takeover:4 is not its generation's");
    expect(
      verdict(TAKEOVER_CLAIM, takeoverBody(payload, "takeover:4", null)),
    ).toBe("its key takeover:4 is not its generation's");
  });

  it("reads a claim written before the envelope, and refuses one whose fields do not read", () => {
    expect(
      verdict(TAKEOVER_CLAIM, legacyTakeover(JSON.stringify(LEGACY))),
    ).toBe("reads");
    expect(
      verdict(
        TAKEOVER_CLAIM,
        legacyTakeover(JSON.stringify({ ...LEGACY, generation: 0, more: 1 })),
      ),
    ).toBe("reads");
    for (const broken of [
      { ...LEGACY, at: undefined },
      { ...LEGACY, at: 5 },
      { ...LEGACY, generation: -1 },
      { ...LEGACY, generation: 1.5 },
      { ...LEGACY, generation: "4" },
      { ...LEGACY, actor: 5 },
      { ...LEGACY, clone: undefined },
    ])
      expect(
        verdict(TAKEOVER_CLAIM, legacyTakeover(JSON.stringify(broken))),
      ).toBe(NOT_A_CLAIM);
    expect(verdict(TAKEOVER_CLAIM, legacyTakeover("[1]"))).toBe(NOT_A_CLAIM);
    expect(verdict(TAKEOVER_CLAIM, legacyTakeover("{"))).toBe(
      "its record is not JSON",
    );
  });
});

// -------------------------------------------------------------- merge-ready

describe("the merge-ready announcement's reader", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  it("reads an announcement whatever its payload holds", () => {
    for (const payload of [{}, { note: "a field it does not know" }])
      expect(
        verdict(
          MERGE_READY,
          claimBody(MERGE_READY, {
            key: `merge-ready:${head}`,
            writer: WRITER,
            payload,
            text: `done\n\n<!-- drive-pr-merge-ready: ${head} -->`,
          }),
        ),
      ).toBe("reads");
  });

  it("reads an announcement that only ends with its head marker", () => {
    expect(
      verdict(
        MERGE_READY,
        `${OPENER}\n\nThe review drive converged.\n\n<!-- drive-pr-merge-ready: ${head} -->`,
      ),
    ).toBe("reads");
    expect(verdict(MERGE_READY, `${OPENER}\n\nNo marker.`)).toBe(
      "it ends with no head marker",
    );
  });
});

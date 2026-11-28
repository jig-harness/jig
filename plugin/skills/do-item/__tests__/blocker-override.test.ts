/**
 * Unit and regression coverage for blocker-override visibility redaction,
 * idempotent attempt markers, indeterminate outcomes, display escaping,
 * and SKILL.md shell/native-Linear contracts.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundError } from "../../../shared/outbound/failure.ts";
import {
  type BlockerOverride,
  ensureOverrideComment,
  markerOverride,
  openBlockers,
  overrideAttemptInBody,
  overrideAttemptsIn,
  overrideComment,
  overrideMarkerLine,
  overrideStatement,
  postCommentChecked,
  recordOverride,
} from "../scripts/lib/blocker-override.ts";
import {
  claimOptions,
  normalizeClaimOptions,
  resolveClaimOptions,
} from "../scripts/lib/claim-options.ts";
import { UsageError } from "../scripts/lib/cli.ts";
import {
  type CommentFact,
  type PoolIssue,
  TrackerRequestError,
} from "../scripts/lib/tracker/port.ts";

function pool(overrides: Partial<PoolIssue> = {}): PoolIssue {
  return {
    identifier: "SEC-9",
    title: "Restricted security fix",
    url: null,
    priority: 1,
    type: null,
    size: null,
    createdAt: "2026-11-27T00:00:00.000Z",
    state: { id: "s1", name: "In Progress", type: "started" },
    assignee: { id: "u1", name: "alice" },
    labels: [],
    isEpic: false,
    hasOpenChildren: false,
    truncated: [],
    ...overrides,
  };
}

function commentTracker(opts: {
  initial?: CommentFact[];
  failRead?: Error | (() => Error | null);
  failPost?: Error | (() => Error | null);
  commitBeforeFail?: boolean;
}) {
  const comments: CommentFact[] = [...(opts.initial ?? [])];
  const posted: string[] = [];
  let reads = 0;
  return {
    comments,
    posted,
    get reads() {
      return reads;
    },
    tracker: {
      async issueComments() {
        reads += 1;
        const err =
          typeof opts.failRead === "function" ? opts.failRead() : opts.failRead;
        if (err) throw err;
        return { uuid: "I_5", comments: [...comments] };
      },
      async postComment(_key: string, body: string) {
        const err =
          typeof opts.failPost === "function" ? opts.failPost() : opts.failPost;
        if (err) {
          if (opts.commitBeforeFail)
            comments.push({
              id: `c-${comments.length + 1}`,
              body,
              createdAt: "2026-11-28T00:00:00.000Z",
              trusted: true,
            });
          throw err;
        }
        posted.push(body);
        comments.push({
          id: `c-${comments.length + 1}`,
          body,
          createdAt: "2026-11-28T00:00:00.000Z",
          trusted: true,
        });
      },
      async updateIssue() {
        return;
      },
    },
  };
}

describe("blocker metadata redaction by shared visibility", () => {
  it("redacts blocker title, state and assignee in persistent records when adapter cannot prove shared visibility", async () => {
    // Adapter omits sharesVisibility (e.g., Linear or Jira): must fail closed.
    const blockers = await openBlockers(
      {
        listRelations: async () => [{ type: "blocked_by", issue: "SEC-9" }],
        poolIssue: async () => pool(),
      },
      "ENG-5",
    );
    expect(blockers).toEqual([
      {
        key: "SEC-9",
        title: "Restricted security fix",
        state: "In Progress",
        assignee: "alice",
        sharedVisibility: false,
      },
    ]);
    const override: BlockerOverride = {
      attempt: "att-1",
      reason: "approved by owner",
      person: "dana",
      blockers,
    };
    // Interactive stderr still informs the claimant whose credentials read it.
    const stderr = overrideStatement("ENG-5", override);
    expect(stderr).toContain(
      'SEC-9 "Restricted security fix": In Progress, assigned to alice',
    );
    // Persistent comment keeps ONLY the blocker key.
    const comment = overrideComment("ENG-5", override);
    expect(comment).toContain("- SEC-9\n");
    expect(comment).not.toContain("Restricted security fix");
    expect(comment).not.toContain("alice");
    expect(comment).not.toContain("In Progress");
    expect(comment).toContain(overrideMarkerLine("att-1"));
    // Persistent claim marker redacts state to null when shared visibility is unverified.
    expect(markerOverride(override)).toEqual({
      override: {
        attempt: "att-1",
        reason: "approved by owner",
        person: "dana",
        blockers: [{ key: "SEC-9", state: null }],
      },
    });
  });

  it("retains blocker metadata only for blockers whose shared visibility is proven", async () => {
    const blockers = await openBlockers(
      {
        listRelations: async () => [
          { type: "blocked_by", issue: "#3" },
          { type: "blocked_by", issue: "acme/private#9" },
        ],
        poolIssue: async (key) =>
          key === "#3"
            ? pool({
                identifier: "#3",
                title: "Public API",
                state: { id: "s1", name: "Todo", type: "unstarted" },
                assignee: { id: "u2", name: "bob" },
              })
            : pool({
                identifier: "acme/private#9",
                title: "Private secret",
                state: { id: "s2", name: "In Progress", type: "started" },
                assignee: { id: "u3", name: "carol" },
              }),
        sharesVisibility: (_issue, other) => other === "#3",
      },
      "#5",
    );
    const override: BlockerOverride = {
      attempt: "att-2",
      reason: "starting UI work",
      person: "dana",
      blockers,
    };
    const comment = overrideComment("#5", override);
    expect(comment).toContain('- #3 "Public API": Todo, assigned to bob');
    expect(comment).toContain("- acme/private#9\n");
    expect(comment).not.toContain("Private secret");
    expect(comment).not.toContain("carol");
    expect(markerOverride(override).override?.blockers).toEqual([
      { key: "#3", state: "Todo" },
      { key: "acme/private#9", state: null },
    ]);
  });

  it("escapes bidi and Unicode separator controls in every display field and rejects zero-width-only reasons", () => {
    const override: BlockerOverride = {
      attempt: "att-3",
      reason: "go\u202enow\u2028ok",
      person: "da\u202ena",
      blockers: [
        {
          key: "#3\u2028",
          title: "Fix\u202eAPI",
          state: "To\u2029do",
          assignee: "al\u001b[31mice",
          sharedVisibility: true,
        },
      ],
    };
    const out = `${overrideStatement("#5", override)}\n${overrideComment("#5", override)}`;
    expect(out.replace(/\n/g, "")).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(() =>
      claimOptions(new Set(["--override-blockers=\u200b\u202e "]), {
        JIG_LAUNCH: "",
      }),
    ).toThrow(UsageError);
  });
});

describe("idempotent blocker-override comment recording", () => {
  const override: BlockerOverride = {
    attempt: "attempt-123",
    reason: "starting early",
    person: "dana",
    blockers: [
      {
        key: "#3",
        title: "API",
        state: "Todo",
        assignee: "bob",
        sharedVisibility: true,
      },
    ],
  };

  it("skips posting when a trusted comment already carries the attempt marker", async () => {
    const body = overrideComment("#5", override);
    const world = commentTracker({
      initial: [
        {
          id: "c-1",
          body,
          createdAt: "2026-11-28T00:00:00.000Z",
          trusted: true,
        },
      ],
    });
    const outcome = await ensureOverrideComment(
      world.tracker,
      "#5",
      body,
      "attempt-123",
    );
    expect(outcome).toEqual({
      status: "posted",
      posted: true,
      attempt: "attempt-123",
      alreadyPresent: true,
    });
    expect(world.posted).toEqual([]);
  });

  it("ignores an untrusted comment carrying the same attempt marker and posts once", async () => {
    const body = overrideComment("#5", override);
    const world = commentTracker({
      initial: [
        {
          id: "c-untrusted",
          body,
          createdAt: "2026-11-28T00:00:00.000Z",
          trusted: false,
        },
      ],
    });
    const outcome = await ensureOverrideComment(
      world.tracker,
      "#5",
      body,
      "attempt-123",
    );
    expect(outcome).toEqual({
      status: "posted",
      posted: true,
      attempt: "attempt-123",
    });
    expect(world.posted).toHaveLength(1);
    expect(overrideAttemptsIn(world.posted[0] as string)).toEqual([
      "attempt-123",
    ]);
  });

  it("reports indeterminate and refuses to post when existing comments cannot be read", async () => {
    const body = overrideComment("#5", override);
    const world = commentTracker({
      failRead: new OutboundError("unreachable", "network timeout"),
    });
    const outcome = await ensureOverrideComment(
      world.tracker,
      "#5",
      body,
      "attempt-123",
    );
    expect(outcome).toMatchObject({
      status: "indeterminate",
      posted: false,
      attempt: "attempt-123",
      marker: overrideMarkerLine("attempt-123"),
    });
    expect(world.posted).toEqual([]);
  });

  it("reconciles a lost response as posted when the write actually committed", async () => {
    const body = overrideComment("#5", override);
    const world = commentTracker({
      failPost: new OutboundError("unreachable", "socket closed", {
        sent: true,
      }),
      commitBeforeFail: true,
    });
    const outcome = await ensureOverrideComment(
      world.tracker,
      "#5",
      body,
      "attempt-123",
    );
    expect(outcome).toEqual({
      status: "posted",
      posted: true,
      attempt: "attempt-123",
      alreadyPresent: true,
    });
    expect(world.reads).toBe(2);
  });

  it("reports indeterminate on a lost response when reconciliation cannot confirm the write", async () => {
    const body = overrideComment("#5", override);
    let readCount = 0;
    const world = commentTracker({
      failPost: new OutboundError("unreachable", "response lost", {
        sent: true,
      }),
      failRead: () => {
        readCount += 1;
        return readCount === 2
          ? new OutboundError("unreachable", "still down")
          : null;
      },
    });
    const outcome = await ensureOverrideComment(
      world.tracker,
      "#5",
      body,
      "attempt-123",
    );
    expect(outcome).toMatchObject({
      status: "indeterminate",
      posted: false,
      attempt: "attempt-123",
      marker: overrideMarkerLine("attempt-123"),
    });
  });

  it("reports not_posted only when an error proves the write was never sent", async () => {
    const body = overrideComment("#5", override);
    const rateLimited = commentTracker({
      failPost: new OutboundError("rate-limited", "budget spent", {
        sent: false,
      }),
    });
    expect(
      await ensureOverrideComment(
        rateLimited.tracker,
        "#5",
        body,
        "attempt-123",
      ),
    ).toMatchObject({
      status: "not_posted",
      posted: false,
      attempt: "attempt-123",
      marker: overrideMarkerLine("attempt-123"),
    });
    const invalid = commentTracker({
      failPost: new TrackerRequestError("invalid", "bad input"),
    });
    expect(
      await ensureOverrideComment(invalid.tracker, "#5", body, "attempt-123"),
    ).toMatchObject({
      status: "not_posted",
      posted: false,
      attempt: "attempt-123",
    });
  });

  it("keeps recordOverride idempotent across retries with the same attempt", async () => {
    const world = commentTracker({});
    const first = await recordOverride(world.tracker, "#5", override, null);
    const second = await recordOverride(world.tracker, "#5", override, null);
    expect(first.comment).toEqual({
      status: "posted",
      posted: true,
      attempt: "attempt-123",
    });
    expect(second.comment).toEqual({
      status: "posted",
      posted: true,
      attempt: "attempt-123",
      alreadyPresent: true,
    });
    expect(world.posted).toHaveLength(1);
  });

  it("refuses malformed or repeated override markers in comment bodies instead of blindly posting", async () => {
    expect(() =>
      overrideAttemptInBody("<!-- jig:blocker-override {bad json} -->"),
    ).toThrow(UsageError);
    expect(() =>
      overrideAttemptInBody(
        `${overrideMarkerLine("a")}\n${overrideMarkerLine("b")}`,
      ),
    ).toThrow(UsageError);
    const world = commentTracker({});
    await expect(
      postCommentChecked(
        world.tracker,
        "#5",
        "## Blocker override\n<!-- jig:blocker-override broken -->",
      ),
    ).rejects.toThrow(UsageError);
    expect(world.posted).toEqual([]);
  });
});

describe("SKILL.md blocker-override shell quoting and native Linear guidance", () => {
  const skillPath = join(import.meta.dir, "../SKILL.md");
  const skill = readFileSync(skillPath, "utf8");

  it("documents the shell-neutral --override-blockers-file path for arbitrary reasons including apostrophes", async () => {
    expect(skill).not.toContain("'<the person's reason>'");
    expect(skill).toContain("--override-blockers-file");

    const dir = mkdtempSync(join(tmpdir(), "jig-override-reason-"));
    try {
      const file = join(dir, "reason.txt");
      const text = "-- It's safe to start ahead of #3: $(echo nope) and `ok`";
      writeFileSync(file, `${text}\n`);
      const rest = ["--override-blockers-file", file];
      normalizeClaimOptions(rest);
      const parsed = await resolveClaimOptions(new Set(rest), {
        JIG_LAUNCH: "",
      });
      expect(parsed.overrideBlockers?.trim()).toBe(text);

      // Disallowed under JIG_LAUNCH without reading the file.
      await expect(
        resolveClaimOptions(
          new Set([`--override-blockers-file=${join(dir, "missing.txt")}`]),
          {
            JIG_LAUNCH: "launch-1",
          },
        ),
      ).rejects.toThrow("JIG_LAUNCH is set");

      // Empty or invisible-only reason file is refused.
      const blank = join(dir, "blank.txt");
      writeFileSync(blank, "\u200b \n");
      await expect(
        resolveClaimOptions(new Set([`--override-blockers-file=${blank}`]), {
          JIG_LAUNCH: "",
        }),
      ).rejects.toThrow(UsageError);

      // Combining inline and file flags is refused.
      await expect(
        resolveClaimOptions(
          new Set([
            "--override-blockers=inline",
            `--override-blockers-file=${file}`,
          ]),
          { JIG_LAUNCH: "" },
        ),
      ).rejects.toThrow("cannot be combined");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes any item with open blockers away from the native Linear shortcut", () => {
    expect(skill).not.toContain("is set or the item has blockers");
    expect(skill).toContain("is set and the item has no open blockers");
    expect(skill).toContain(
      "including an epic, any issue with sub-issues, or an open blocker",
    );
  });
});

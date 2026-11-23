/**
 * quota-weekly.test.ts — Claude Code's weekly usage-limit notice in the
 * Claude quota adapter (`scripts/lib/quota/claude.ts`): its dated reset, and
 * the pass's own transcripts read by session id when the bounded walk is cut
 * short. The notice's wording is transcribed from a pass that met it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "../scripts/lib/quota/claude.ts";
import { planFor } from "../scripts/lib/quota/index.ts";
import type { QuotaBlock } from "../scripts/lib/quota/types.ts";

const CWD = "/Users/dev/workspaces/proj/alpha";
const ENV_KEYS = [
  "DRIVE_PR_CLAUDE_PROJECTS_DIR",
  "DRIVE_PR_QUOTA_MAX_SCAN_MS",
] as const;

let root: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "drive-pr-quota-weekly-"));
  process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = join(root, "claude");
  delete process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** One Claude transcript line, in the measured record shape. */
function claudeWall(opts: {
  cwd: string;
  timestamp: string;
  text: string;
  sessionId?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    cwd: opts.cwd,
    timestamp: opts.timestamp,
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    sessionId: opts.sessionId,
    message: { content: [{ type: "text", text: opts.text }] },
  });
}

function writeClaude(name: string, lines: string[]): void {
  const dir = join(root, "claude", "-Users-dev-workspaces-proj-alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

describe("claude adapter: the weekly notice", () => {
  const WEEKLY =
    "You've hit your weekly limit · resets Nov 27, 11am (Europe/Amsterdam)";
  const AT = "2026-11-23T19:43:11.000Z";
  const W_SINCE = Temporal.Instant.from("2026-11-23T19:43:00.000Z");
  const W_NOW = Temporal.Instant.from("2026-11-23T19:45:00.000Z");
  const weekly = (text: string, timestamp = AT, sessionId?: string) =>
    claudeWall({
      cwd: CWD,
      timestamp,
      text,
      ...(sessionId ? { sessionId } : {}),
    });

  it("reads the measured weekly notice as a WEEKLY wall with the dated reset it states", () => {
    writeClaude("s.jsonl", [weekly(WEEKLY)]);
    const b = claudeAdapter.detect({ cwd: CWD, since: W_SINCE, now: W_NOW });
    expect(b?.window).toBe("weekly");
    // 11am in Amsterdam on 27 November is 10:00 UTC (CET, UTC+1).
    expect(b?.resetAt?.toString({ fractionalSecondDigits: 3 })).toBe(
      "2026-11-27T10:00:00.000Z",
    );
    expect(b?.evidence).toBe(
      "weekly limit · resets Nov 27, 11am (Europe/Amsterdam)",
    );
    expect(planFor(b as QuotaBlock, W_NOW).action).toBe("stop");
  });

  it("resolves a reset past the year's end into the next year", () => {
    writeClaude("s.jsonl", [
      weekly(
        "You've hit your weekly limit · resets January 2, 9:30am (UTC)",
        "2025-12-29T08:00:00.000Z",
      ),
    ]);
    const b = claudeAdapter.detect({
      cwd: CWD,
      since: Temporal.Instant.from("2025-12-29T07:59:00.000Z"),
      now: Temporal.Instant.from("2025-12-29T08:01:00.000Z"),
    });
    expect(b?.window).toBe("weekly");
    expect(b?.resetAt?.toString({ fractionalSecondDigits: 3 })).toBe(
      "2026-01-02T09:30:00.000Z",
    );
  });

  it("keeps the unknown-window handling when the clause's reset does not resolve", () => {
    for (const text of [
      // A zone the runtime does not know.
      "You've hit your weekly limit · resets Nov 27, 11am (Mars/Olympus)",
      // A date that does not exist.
      "You've hit your weekly limit · resets Feb 30, 11am (Europe/Amsterdam)",
      // A date already past this year, so the next one is a year out.
      "You've hit your weekly limit · resets Nov 20, 11am (Europe/Amsterdam)",
    ]) {
      writeClaude("s.jsonl", [weekly(text)]);
      const b = claudeAdapter.detect({ cwd: CWD, since: W_SINCE, now: W_NOW });
      expect({ text, window: b?.window, resetAt: b?.resetAt }).toEqual({
        text,
        window: "unknown",
        resetAt: null,
      });
    }
  });

  it("does NOT read a weekly phrase with anything around the notice as the weekly notice", () => {
    for (const text of [
      `Note: ${WEEKLY}`,
      `${WEEKLY} — try again later`,
      "You've hit your weekly limit soon · resets Nov 27, 11am (Europe/Amsterdam)",
    ]) {
      writeClaude("s.jsonl", [weekly(text)]);
      const b = claudeAdapter.detect({ cwd: CWD, since: W_SINCE, now: W_NOW });
      expect({ text, window: b?.window, resetAt: b?.resetAt }).toEqual({
        text,
        window: "unknown",
        resetAt: null,
      });
    }
  });

  it("finds the pass's own transcript by its session id when the walk is cut short", () => {
    const sid = "0b9f6a0e-4c1d-4a8e-9f3e-2d6c1a7b8e90";
    writeClaude(`${sid}.jsonl`, [weekly(WEEKLY, AT, sid)]);
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
    const truncated: string[] = [];
    const b = claudeAdapter.detect({
      cwd: CWD,
      since: W_SINCE,
      now: W_NOW,
      correlation: { vendor: "claude", sessionId: sid },
      onScanTruncated: (vendor) => truncated.push(vendor),
    });
    expect(b?.window).toBe("weekly");
    expect(truncated).toEqual([]);
  });

  it("finds the pass's subagent transcripts by its session id when the walk is cut short", () => {
    const sid = "5e2b7c41-8f0a-4d3e-b6a9-1c4f7e2d9a03";
    const dir = join(
      root,
      "claude",
      "-Users-dev-workspaces-proj-alpha",
      sid,
      "subagents",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-a1.jsonl"), `${weekly(WEEKLY, AT, sid)}\n`);
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
    const b = claudeAdapter.detect({
      cwd: CWD,
      since: W_SINCE,
      now: W_NOW,
      correlation: { vendor: "claude", sessionId: sid },
    });
    expect(b?.window).toBe("weekly");
  });

  it("still matches the session id on the record, not only the file's name", () => {
    const sid = "7d1e3f52-6a8b-4c9d-8e0f-1a2b3c4d5e6f";
    writeClaude(`${sid}.jsonl`, [weekly(WEEKLY, AT, "another-session")]);
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
    const realError = console.error;
    console.error = () => {
      // The discard diagnostic is expected here; keep the output quiet.
    };
    try {
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: W_SINCE,
          now: W_NOW,
          correlation: { vendor: "claude", sessionId: sid },
        }),
      ).toBeNull();
    } finally {
      console.error = realError;
    }
  });

  it("reports no cut-short walk when the session's own transcript was read whole", () => {
    const sid = "3c8a2f10-9b4d-4e6a-8c1f-0d2e4b6a8c10";
    writeClaude(`${sid}.jsonl`, [
      JSON.stringify({ type: "user", sessionId: sid, timestamp: AT }),
    ]);
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
    const truncated: string[] = [];
    expect(
      claudeAdapter.detect({
        cwd: CWD,
        since: W_SINCE,
        now: W_NOW,
        correlation: { vendor: "claude", sessionId: sid },
        onScanTruncated: (vendor) => truncated.push(vendor),
      }),
    ).toBeNull();
    expect(truncated).toEqual([]);
  });

  it("still reports the cut-short walk when the session's transcript is nowhere to be read", () => {
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
    mkdirSync(join(root, "claude", "-Users-dev-workspaces-proj-alpha"), {
      recursive: true,
    });
    const truncated: string[] = [];
    const realError = console.error;
    console.error = () => {
      // The truncation line is expected here; keep the output quiet.
    };
    try {
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: W_SINCE,
          now: W_NOW,
          correlation: { vendor: "claude", sessionId: "absent-session" },
          onScanTruncated: (vendor) => truncated.push(vendor),
        }),
      ).toBeNull();
    } finally {
      console.error = realError;
    }
    expect(truncated).toEqual(["claude"]);
  });

  it("keeps the bounded walk, its message and its signal for a pass with no session id", () => {
    writeClaude("s.jsonl", [weekly(WEEKLY)]);
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
    const said: string[] = [];
    const truncated: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };
    try {
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: W_SINCE,
          now: W_NOW,
          onScanTruncated: (vendor) => truncated.push(vendor),
        }),
      ).toBeNull();
    } finally {
      console.error = realError;
    }
    expect(said.join("\n")).toContain(
      "detection scan over ~/.claude/projects was truncated",
    );
    expect(truncated).toEqual(["claude"]);
  });
});

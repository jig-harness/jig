/**
 * The drive on the forge's spent rate limit (`lib/forge-limit.ts`,
 * `lib/driver/forge-limit-stop.ts`): the attach waits for a near reset and
 * reads again, a reset further off stops the drive `FORGE_RATE_LIMITED` with
 * the reset recorded, and the closing report of that stop names the reset and
 * hands the next step to the line.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AttachRefusal, attachThroughLimits } from "../scripts/lib/attach.ts";
import {
  answerForgeLimit,
  attachForgeLimit,
  LIMIT_WAITS,
} from "../scripts/lib/driver/forge-limit-stop.ts";
import { composeDriverReport } from "../scripts/lib/driver/closing-report.ts";
import type { DriveRoundContext } from "../scripts/lib/driver/round-context.ts";
import { driverRuntime } from "../scripts/lib/driver/runtime.ts";
import {
  forgeLimitOf,
  limitPlan,
  rateLimitWaitMs,
  reportLimit,
} from "../scripts/lib/forge-limit.ts";
import type { DriveState } from "../scripts/lib/state/schema.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";
import { limitedAtStart } from "../scripts/lib/status/pre-report.ts";
import { ExitError } from "../../../shared/cli.ts";
import {
  clearForgeLimit,
  forgeLimitHeld,
  noteForgeAnswer,
} from "../../../shared/outbound/forge-limit-seen.ts";
import { outboundFailure } from "../../../shared/outbound/failure.ts";
import { currentMs, isoFromMs } from "../../../shared/time.ts";

afterEach(() => {
  driverRuntime.stopLimitedUntil = null;
  driverRuntime.forgeLimitWaits = 0;
  clearForgeLimit();
});

/** The refusal the attach's read throws when the limit refused it. */
function limited(until: number): AttachRefusal {
  return new AttachRefusal(1, "cannot read PR #42: rate limit spent", {
    until,
    reason: "GitHub's rate limit for this credential is spent",
  });
}

describe("the attach on a spent forge rate limit", () => {
  test("waits for a reset inside the bound, then reads again and attaches", async () => {
    const until = currentMs() + 300;
    let reads = 0;
    const attached = await attachThroughLimits(
      async () => {
        reads += 1;
        if (reads === 1) throw limited(until);
        return "attached";
      },
      undefined,
      (limit, mayWait) =>
        attachForgeLimit("42", limit, mayWait, {
          boundMs: 60_000,
          marginMs: 0,
        }),
    );
    expect(attached).toBe("attached");
    expect(reads).toBe(2);
    expect(currentMs()).toBeGreaterThanOrEqual(until);
    expect(driverRuntime.stopLimitedUntil).toBeNull();
  });

  test("stops FORGE_RATE_LIMITED, not exit 1, on a reset past the bound", async () => {
    const until = currentMs() + 3_600_000;
    let reads = 0;
    const attach = attachThroughLimits(
      async () => {
        reads += 1;
        throw limited(until);
      },
      undefined,
      (limit, mayWait) =>
        attachForgeLimit("42", limit, mayWait, { boundMs: 60_000 }),
    );
    const error = await attach.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).code).toBe(DRIVE_EXIT.FORGE_RATE_LIMITED);
    expect(reads).toBe(1);
    expect(driverRuntime.stopLimitedUntil).toBe(isoFromMs(until));
  });

  test("stops on the limit once its waits are spent, a reset near or not", async () => {
    let reads = 0;
    const error = await attachThroughLimits(
      async () => {
        reads += 1;
        throw limited(currentMs() + 10);
      },
      undefined,
      (limit, mayWait) =>
        attachForgeLimit("42", limit, mayWait, {
          boundMs: 60_000,
          marginMs: 0,
        }),
    ).catch((e: unknown) => e);
    expect((error as ExitError).code).toBe(DRIVE_EXIT.FORGE_RATE_LIMITED);
    expect(reads).toBe(4);
  });

  test("any other refusal keeps its own exit", async () => {
    const error = await attachThroughLimits(
      async () => {
        throw new AttachRefusal(1, "cannot read PR #42: boom");
      },
      undefined,
      async () => true,
    ).catch((e: unknown) => e);
    expect((error as ExitError).code).toBe(1);
  });
});

describe("the round loop on a status probe that stopped on the limit", () => {
  const context = { pr: "42" } as DriveRoundContext;

  test("stops on a reset past the bound, recording the reset", async () => {
    const until = currentMs() + 24 * 3_600_000;
    const status = { rateLimit: reportLimit({ until, reason: "spent" }) };
    expect(await answerForgeLimit(context, status)).toBe(
      DRIVE_EXIT.FORGE_RATE_LIMITED,
    );
    expect(driverRuntime.stopLimitedUntil).toBe(isoFromMs(until));
  });

  test("stops on a near reset once it waited for as many resets in a row as it may", async () => {
    driverRuntime.forgeLimitWaits = LIMIT_WAITS;
    const until = currentMs() + 1_000;
    const status = { rateLimit: reportLimit({ until, reason: "spent" }) };
    expect(await answerForgeLimit(context, status)).toBe(
      DRIVE_EXIT.FORGE_RATE_LIMITED,
    );
    expect(driverRuntime.stopLimitedUntil).toBe(isoFromMs(until));
  });

  test("stops, naming no reset, on a report that names none", async () => {
    expect(await answerForgeLimit(context, {})).toBe(
      DRIVE_EXIT.FORGE_RATE_LIMITED,
    );
    expect(driverRuntime.stopLimitedUntil).toBeNull();
  });
});

describe("the closing report of a stop on the limit", () => {
  test("names the reset, cause environment, the line owning the next step", () => {
    const until = isoFromMs(currentMs() + 3_600_000);
    const state = {
      events: [
        {
          at: isoFromMs(currentMs()),
          round: 2,
          kind: "stop",
          cause: String(DRIVE_EXIT.FORGE_RATE_LIMITED),
          until,
        },
      ],
    } as unknown as DriveState;
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.FORGE_RATE_LIMITED,
      state,
      round: null,
    });
    expect(report.concluded).toContain(until);
    expect(report.cause).toBe("environment");
    expect(report.suggested_next.owner).toBe("line");
  });

  test("names the reset this driver is recording when the state has none", () => {
    const until = isoFromMs(currentMs() + 3_600_000);
    driverRuntime.stopLimitedUntil = until;
    const report = composeDriverReport({
      pr: "42",
      code: DRIVE_EXIT.FORGE_RATE_LIMITED,
      state: null,
      round: null,
    });
    expect(report.concluded).toContain(until);
  });
});

describe("the limit's reading", () => {
  test("a held gh run names the limit and its reset", () => {
    const until = currentMs() + 60_000;
    const held = outboundFailure("rate-limited", "spent; nothing was sent", {
      until,
    });
    const limit = forgeLimitOf({
      code: 1,
      stderr: `${held.reason}\n`,
      timedOut: false,
      held,
    });
    expect(limit?.until).toBe(until);
  });

  test("any other failure names none", () => {
    expect(
      forgeLimitOf({
        code: 1,
        stderr: "HTTP 404: Not Found\n",
        timedOut: false,
      }),
    ).toBeNull();
  });

  test("the process record holds the latest limit until a success or its reset", () => {
    const until = currentMs() + 60_000;
    noteForgeAnswer(outboundFailure("rate-limited", "spent", { until }));
    expect(forgeLimitHeld()?.until).toBe(until);
    noteForgeAnswer(outboundFailure("unreachable", "lost"));
    expect(forgeLimitHeld()?.until).toBe(until);
    expect(forgeLimitHeld(until + 1)).toBeNull();
    noteForgeAnswer(null);
    expect(forgeLimitHeld()).toBeNull();
  });

  test("the wait bound reads DRIVE_PR_RATE_LIMIT_WAIT, a whole number of seconds up to a day", () => {
    expect(rateLimitWaitMs({})).toBe(30 * 60_000);
    expect(rateLimitWaitMs({ DRIVE_PR_RATE_LIMIT_WAIT: "0" })).toBe(0);
    expect(rateLimitWaitMs({ DRIVE_PR_RATE_LIMIT_WAIT: "120" })).toBe(120_000);
    expect(rateLimitWaitMs({ DRIVE_PR_RATE_LIMIT_WAIT: "-5" })).toBe(
      30 * 60_000,
    );
    expect(rateLimitWaitMs({ DRIVE_PR_RATE_LIMIT_WAIT: "999999" })).toBe(
      30 * 60_000,
    );
  });

  test("a reset inside the bound is waited for past it, one further off is not", () => {
    const now = 1_000_000;
    expect(
      limitPlan({ until: now + 10_000 }, now, { boundMs: 60_000, marginMs: 5 }),
    ).toEqual({ action: "wait", ms: 10_005 });
    expect(
      limitPlan({ until: now - 10 }, now, { boundMs: 0, marginMs: 5 }),
    ).toEqual({ action: "wait", ms: 5 });
    expect(
      limitPlan({ until: now + 60_001 }, now, { boundMs: 60_000 }),
    ).toEqual({ action: "stop" });
  });
});

describe("limitedAtStart", () => {
  test("prints the state name on standard output outside --json", () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    const errors = console.error;
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    console.error = () => undefined;
    try {
      const code = limitedAtStart("42", false, {
        until: currentMs() + 1000,
        reason: "spent",
      });
      expect(code).toBe(DRIVE_EXIT.FORGE_RATE_LIMITED);
    } finally {
      process.stdout.write = original;
      console.error = errors;
    }
    expect(writes.join("")).toBe("FORGE_RATE_LIMITED\n");
  });
});

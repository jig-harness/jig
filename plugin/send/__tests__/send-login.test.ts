/**
 * The login a send writes as, when it cannot be had: a forge read that
 * failed names its class (a spent allowance with its reset time, a refused
 * credential, no answer) and that nothing was sent; a forge that answered
 * and named no login keeps its own refusal. The tracker's user, read for an
 * assignment or a tracker answer, is refused the same way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { OutboundError } from "../../shared/outbound/failure.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { trackerWriter } from "../lib/plan.ts";
import {
  pullRequest,
  REPO,
  type SendWorld,
  sendWorld,
} from "./send-fixtures.ts";

let current: SendWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function world(): SendWorld {
  current = sendWorld();
  pullRequest(current, 12, [], []);
  return current;
}

const ADDRESS = `drive@${REPO}#12`;
const NOT_NAMED = "did not name the login this machine is signed in as";
/** A reset time GitHub names for a spent allowance, in epoch seconds. */
const RESET_SEC = 4_102_444_800;
const RESET_ISO = "2100-01-01T00:00:00.000Z";

describe("jig send when the forge login is not read", () => {
  it("names a spent allowance and its reset time, and sends nothing", async () => {
    const w = world();
    w.refuse(
      "user",
      `HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: ${RESET_SEC}`,
      "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
    );
    const r = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "the login this machine is signed in as on the forge was not read, so nothing was sent",
    );
    expect(r.stderr).toContain(
      `the credential's allowance on the forge is spent until ${RESET_ISO}; send again after then`,
    );
    expect(r.stderr).not.toContain(NOT_NAMED);
    expect(w.writes()).toEqual([]);
  });

  it("names a refused credential", async () => {
    const w = world();
    w.refuse(
      "user",
      "HTTP/2.0 401 Unauthorized",
      "gh: Bad credentials (HTTP 401)",
    );
    const r = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("the forge refused the credential");
    expect(r.stderr).toContain("sign in again, then send again");
    expect(r.stderr).not.toContain(NOT_NAMED);
    expect(w.writes()).toEqual([]);
  });

  it("keeps its own refusal when the forge answers and names no login", async () => {
    const w = world();
    w.api("user", { id: 1 });
    const r = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(`the forge ${NOT_NAMED}`);
    expect(w.writes()).toEqual([]);
  });
});

/** A tracker whose viewer read does what `viewer` does. */
const tracker = (viewer: Tracker["viewer"]) =>
  ({ viewer }) as Pick<Tracker, "viewer">;

describe("the tracker's user a send writes as", () => {
  it("names a spent allowance and its reset time", async () => {
    const r = await trackerWriter(
      tracker(async () => {
        throw new OutboundError("rate-limited", "Linear: rate limited", {
          until: RESET_SEC * 1000,
        });
      }),
      5,
      undefined,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe(
      `the login this machine is signed in as on the tracker was not read, so nothing was sent: the credential's allowance on the tracker is spent until ${RESET_ISO}; send again after then`,
    );
  });

  it("names a refused credential and a read that did not answer in time", async () => {
    const refused = await trackerWriter(
      tracker(async () => {
        throw new OutboundError("unauthorized", "HTTP 401");
      }),
      5,
      undefined,
    );
    expect(refused.ok ? null : refused.failure.reason).toContain(
      "the tracker refused the credential (HTTP 401)",
    );
    const late = await trackerWriter(
      tracker(
        (signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
      1,
      undefined,
    );
    expect(late.ok ? null : late.failure.reason).toContain(
      "the tracker did not answer (no answer within the answer's deadline (1 s))",
    );
  });

  it("keeps its own refusal for a user with no name, and checks --as", async () => {
    const nameless = await trackerWriter(
      tracker(async () => ({ id: "u-1", name: "" })),
      5,
      undefined,
    );
    expect(nameless.ok ? null : nameless.failure.reason).toContain(
      `the tracker ${NOT_NAMED}`,
    );
    const other = await trackerWriter(
      tracker(async () => ({ id: "u-1", name: "dana" })),
      5,
      "someone-else",
    );
    expect(other.ok ? null : other.failure.reason).toContain(
      "this machine is signed in as dana on the tracker",
    );
    const named = await trackerWriter(
      tracker(async () => ({ id: "u-1", name: "dana" })),
      5,
      undefined,
    );
    expect(named.ok ? named.value.login : null).toBe("dana");
  });
});

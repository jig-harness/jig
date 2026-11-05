/**
 * The driver's mailbox checkpoint (`lib/driver/mailbox.ts`): a pause keeps the
 * drive's ledger heartbeat renewed, a clear checkpoint writes nothing, a
 * `stop` ends only the driver generation it names (every later one when it
 * names none), and the driver acknowledges what it acted on in the outbox.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitAtMailboxCheckpoint } from "../scripts/lib/driver/mailbox.ts";
import {
  appendDirective,
  foldGateState,
  outboxRecordsForPr,
  parseOutboxRecord,
} from "../scripts/lib/state/mailbox.ts";
import { immediateStop } from "../scripts/lib/state/mailbox-stop.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drive-pr-mailbox-checkpoint-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = (generation: number) => ({ dir, pr: "999", generation });

/** The outbox's acknowledgements, as [directive id, driver generation]. */
function acks(): Array<[string, number | undefined]> {
  const out = outboxRecordsForPr(dir, "999");
  if (!out.ok) throw new Error(out.why);
  return out.records
    .filter((r) => r.status === "ack")
    .map((r) => [r.id, r.generation]);
}

describe("waitAtMailboxCheckpoint", () => {
  it("renews the ledger heartbeat while paused, and not at a clear checkpoint", async () => {
    let renewals = 0;
    const renew = async () => {
      renewals += 1;
      return null;
    };
    expect(await waitAtMailboxCheckpoint(at(1), 1, renew)).toBe("clear");
    expect(renewals).toBe(0);
    const pause = await appendDirective(dir, "999", "orchestrator", "pause");
    expect(await waitAtMailboxCheckpoint(at(1), 1, renew)).toBe(
      "pause-timeout",
    );
    expect(renewals).toBeGreaterThan(0);
    // Acknowledged once, however many polls the pause lasted.
    expect(acks()).toEqual([[pause.id, 1]]);
  });

  it("ends a pause as taken over when the renewal finds a newer claim", async () => {
    await appendDirective(dir, "999", "orchestrator", "pause");
    expect(await waitAtMailboxCheckpoint(at(1), 60, async () => 20)).toBe(
      "taken-over",
    );
  });
});

describe("a mailbox stop", () => {
  it("addressed to a driver generation ends that driver and no later one, and is acknowledged", async () => {
    const stop = await appendDirective(dir, "999", "orchestrator", "stop", {
      generation: 3,
    });
    expect(await waitAtMailboxCheckpoint(at(3), 1)).toBe("stopped");
    expect(await waitAtMailboxCheckpoint(at(4), 1)).toBe("clear");
    expect(acks()).toEqual([[stop.id, 3]]);
  });

  it("naming no generation ends every later driver until resume, which withdraws addressed stops too", async () => {
    const stop = await appendDirective(dir, "999", "orchestrator", "stop");
    await appendDirective(dir, "999", "orchestrator", "stop", {
      generation: 6,
    });
    expect(await waitAtMailboxCheckpoint(at(5), 1)).toBe("stopped");
    expect(await waitAtMailboxCheckpoint(at(7), 1)).toBe("stopped");
    expect(acks()).toEqual([
      [stop.id, 5],
      [stop.id, 7],
    ]);
    await appendDirective(dir, "999", "orchestrator", "resume", {
      target: "stop",
    });
    expect(await waitAtMailboxCheckpoint(at(6), 1)).toBe("clear");
    expect(await waitAtMailboxCheckpoint(at(8), 1)).toBe("clear");
  });

  it("marked now is the stop watch's to act on, not the round boundary's", async () => {
    const stop = await appendDirective(dir, "999", "drives.ts --stop", "stop", {
      generation: 2,
      now: true,
    });
    expect(await waitAtMailboxCheckpoint(at(2), 1)).toBe("clear");
    expect(immediateStop(dir, "999", 2)).toBe(stop.id);
    expect(immediateStop(dir, "999", 3)).toBeNull();
  });
});

describe("a stop's address", () => {
  const directive = (fields: Record<string, unknown>) => ({
    id: "m-1",
    ts: "2026-11-05T00:00:00.000Z",
    kind: "directive",
    from: "test",
    pr: "999",
    command: "stop",
    ...fields,
  });

  it("is a positive whole generation on a stop, and now only beside one; any other shape poisons the fold", () => {
    for (const fields of [
      { command: "pause", generation: 2 },
      { generation: 0 },
      { generation: 1.5 },
      { generation: "2" },
      { now: true },
      { generation: 2, now: "yes" },
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "inbox.jsonl"),
        `${JSON.stringify(directive(fields))}\n`,
      );
      expect({ fields, ok: foldGateState(dir, "999").ok }).toEqual({
        fields,
        ok: false,
      });
    }
  });

  it("is acknowledged by an outbox record naming the driver generation", () => {
    const ack = { id: "m-1", ts: "2026-11-05T00:00:00.000Z", pr: "999" };
    expect(parseOutboxRecord({ ...ack, status: "ack", generation: 3 })).toEqual(
      { ...ack, status: "ack", generation: 3 },
    );
    expect(parseOutboxRecord({ ...ack, status: "ack" })).toBeNull();
    expect(
      parseOutboxRecord({
        ...ack,
        status: "ack",
        generation: 3,
        response: "x",
      }),
    ).toBeNull();
  });
});

/**
 * A system that did not answer is not asked again in the same run, and the
 * next run sends it one probe, alone, before it reads on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OutboundFailure, outboundFailure } from "../outbound/failure.ts";
import {
  guarded,
  heldSystems,
  holdUnanswered,
  stopHolding,
} from "../outbound/hold.ts";

const dirs: string[] = [];
afterEach(() => {
  stopHolding();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function holdFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "outbound-hold-"));
  dirs.push(dir);
  return join(dir, "unanswered.json");
}

/** A system whose answers are `answers` in turn; it counts what it was sent. */
function system(answers: (OutboundFailure | null)[]) {
  let sent = 0;
  const send = async () => answers[sent++] ?? null;
  return {
    call: () =>
      guarded(
        "forge",
        send,
        (a) => a,
        (held) => held,
      ),
    sent: () => sent,
  };
}

const DOWN = outboundFailure("unreachable", "no such host");

describe("guarded", () => {
  it("sends every request when the run holds nothing", async () => {
    const s = system([DOWN, DOWN]);
    await s.call();
    await s.call();
    expect(s.sent()).toBe(2);
  });

  it("sends nothing more in the run to a system that did not answer", async () => {
    const path = holdFile();
    holdUnanswered(path);
    const s = system([DOWN]);
    expect(await s.call()).toMatchObject({ code: "unreachable" });
    const refused = await s.call();
    expect(refused).toMatchObject({ code: "unreachable" });
    expect(refused?.reason).toContain("did not answer earlier in this run");
    expect(s.sent()).toBe(1);
    expect([...heldSystems().keys()]).toEqual(["forge"]);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual([
      "forge",
    ]);
  });

  it("keeps asking a system that answered, even with a refusal", async () => {
    holdUnanswered(holdFile());
    const s = system([outboundFailure("not-found", "gone"), null]);
    await s.call();
    await s.call();
    expect(s.sent()).toBe(2);
  });

  it("sends the next run's first request alone, and the rest only once it is answered", async () => {
    const path = holdFile();
    holdUnanswered(path);
    await system([DOWN]).call();
    // The next run: three requests at once, one probe.
    holdUnanswered(path);
    const gate = Promise.withResolvers<void>();
    let sent = 0;
    const send = async () => {
      sent++;
      if (sent === 1) await gate.promise;
      return null;
    };
    const calls = [1, 2, 3].map(() =>
      guarded(
        "forge",
        send,
        (a: OutboundFailure | null) => a,
        (held) => held,
      ),
    );
    await Bun.sleep(0);
    expect(sent).toBe(1);
    gate.resolve();
    await Promise.all(calls);
    expect(sent).toBe(3);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("holds the system for the run again when its probe is not answered", async () => {
    const path = holdFile();
    holdUnanswered(path);
    await system([DOWN]).call();
    holdUnanswered(path);
    const s = system([DOWN]);
    const [probe, after] = await Promise.all([s.call(), s.call()]);
    expect(probe).toMatchObject({ code: "unreachable" });
    expect(after?.reason).toContain("did not answer earlier in this run");
    expect(s.sent()).toBe(1);
  });

  it("holds a system whose call threw that it did not answer, and rethrows", async () => {
    holdUnanswered(holdFile());
    let sent = 0;
    const call = () =>
      guarded(
        "tracker",
        async () => {
          sent++;
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        },
        () => null,
        (held) => {
          throw new Error(held.reason);
        },
      );
    await expect(call()).rejects.toThrow("timed out");
    await expect(call()).rejects.toThrow("did not answer earlier");
    expect(sent).toBe(1);
  });
});

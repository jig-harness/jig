/**
 * A driver lock's claim names its host by the shared host id
 * (`shared/liveness.ts`) beside its name, so a claim this machine wrote under
 * an earlier host name is judged by its pid, and one from another machine
 * stays unanswerable whatever name it carries.
 */
import { describe, expect, it } from "bun:test";
import { hostname } from "node:os";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { thisHost } from "../../../shared/liveness.ts";
import {
  claimLive,
  formatClaim,
  ownClaim,
  parseClaimText,
  samePidNamespace,
} from "../scripts/lib/claim.ts";

/** A pid that has exited: a child run to completion. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", "0"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(child, 0);
  return child.pid;
}

describe("a driver claim's host", () => {
  it("writes this machine's host id after the platform, and reads it back", () => {
    const here = thisHost();
    const record = parseClaimText(ownClaim());
    expect(record).toMatchObject({
      pid: process.pid,
      host: hostname(),
      platform: process.platform,
      hostId: here.hostId,
    });
    expect(parseClaimText(formatClaim(7, "box"))).not.toHaveProperty("hostId");
  });

  it("judges a claim written under this host's earlier name by its pid", () => {
    const renamed = {
      pid: deadPid(),
      host: "an-earlier-name.local",
      hostId: thisHost().hostId,
      platform: process.platform,
      ageMs: 0,
    };
    expect(samePidNamespace(renamed)).toBe(true);
    expect(claimLive(renamed)).toBe(false);
    expect(claimLive({ ...renamed, pid: process.pid })).toBe(true);
  });

  it("leaves a claim from another host id unanswerable, even under this host's name", () => {
    const elsewhere = parseClaimText(
      formatClaim(deadPid(), hostname(), undefined, "f".repeat(32)),
    );
    if (elsewhere === null) throw new Error("the claim does not parse");
    expect(samePidNamespace(elsewhere)).toBe(false);
    expect(claimLive({ ...elsewhere, ageMs: 0 })).toBe(true);
  });
});

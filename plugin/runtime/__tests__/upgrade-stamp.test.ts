import { expect, test } from "bun:test";
import { ownIdentity } from "../../shared/liveness.ts";
import { ownsClaim, type StampRead } from "../upgrade-stamp.ts";

function claimBy(host: string): StampRead {
  const holder = { ...ownIdentity(), host };
  return {
    stamp: {
      outcome: "running",
      detail: "claimed",
      at: new Date().toISOString(),
      pid: holder.pid,
      holder,
    },
  };
}

test("a claim stays its holder's after the machine is renamed, and is no other process's", () => {
  expect(ownsClaim(claimBy(ownIdentity().host))).toBe(true);
  expect(ownsClaim(claimBy("renamed-since-the-claim"))).toBe(true);
  const read = claimBy(ownIdentity().host);
  if ("stamp" in read && read.stamp.holder !== undefined)
    read.stamp.holder = {
      ...read.stamp.holder,
      start: "Mon Jan  1 00:00:01 1990",
    };
  expect(ownsClaim(read)).toBe(false);
});

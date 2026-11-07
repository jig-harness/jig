/** A person's new re-arm request supersedes ended foreign refusals, never live claims. */
import { expect, it } from "bun:test";
import { ok } from "../../shared/outcome.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
import { factsOf } from "../lib/actions/drive-hold.ts";
import { foreignHold } from "../lib/shared-launches.ts";
import type { DrivenPr } from "../lib/types.ts";
const pr: DrivenPr = {
  number: 7,
  url: "",
  title: "",
  head: "feature/7",
  class: "re-armable",
  why: "explicit rearm",
  evidence: {
    rearm: true,
    generation: 3,
    exit: 12,
    heartbeat: "2026-11-07T00:00:00.000Z",
  },
};
function claim(ended: boolean): SharedClaim {
  return {
    id: 1,
    stage: "drive",
    login: "maintainer",
    createdAt: "2026-11-07T00:00:00.000Z",
    trusted: true,
    says: ok({
      pr: 7,
      attempt: 1,
      at: "2026-11-07T00:00:00.000Z",
      run: "tick",
      action: "rearm",
      record: "foreign-record",
      host: "foreign-host",
      owner: true,
      facts: factsOf(pr),
      change: null,
      conflictStop: false,
      end: ended
        ? {
            state: "ended",
            at: "2026-11-07T00:01:00.000Z",
            exit: 11,
            outcome: null,
          }
        : null,
      legacy: false,
    }),
  };
}
it("lets an explicit rearm supersede an ended foreign refusal on unchanged ledger facts", () => {
  expect(foreignHold(pr, ok([claim(true)]), "local-host").kind).toBe("none");
  expect(
    foreignHold(
      { ...pr, evidence: { ...pr.evidence, rearm: false } },
      ok([claim(true)]),
      "local-host",
    ).kind,
  ).toBe("refused");
});
it("keeps a foreign live claim holding an explicit rearm request", () => {
  expect(foreignHold(pr, ok([claim(false)]), "local-host").kind).toBe("held");
});

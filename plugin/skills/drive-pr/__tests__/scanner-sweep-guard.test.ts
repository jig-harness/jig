import { describe, expect, it } from "bun:test";
import { mayResolveDeclinedAlert } from "../scripts/lib/scanner-sweep-guard.ts";

describe("declined code scanning findings", () => {
  it("resolves only when the alert is confirmed dismissed", () => {
    expect(mayResolveDeclinedAlert(undefined)).toBe(true);
    expect(mayResolveDeclinedAlert({ state: "dismissed" })).toBe(true);
    for (const alert of [
      { state: "open" },
      { state: null },
      { state: "fixed" },
      { state: "dismissed", unreadable: "denied" },
      null,
      {},
    ]) {
      expect(mayResolveDeclinedAlert(alert)).toBe(false);
    }
  });
});

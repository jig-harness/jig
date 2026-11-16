import { expect, it } from "bun:test";
import { nativeFacts } from "../lib/sources/native-facts.ts";
import type {
  DispatchRawIssue,
  DispatchSource,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";

function row(identifier: string): DispatchRawIssue {
  return { identifier, value: {} };
}

it("falls back per key after a non-rate-limited native batch failure", async () => {
  const singles: string[] = [];
  const source: DispatchSource = {
    credential: async () => "credential",
    queue: async () => [],
    issue: async (key) => {
      singles.push(key);
      return row(key);
    },
    issues: async () => {
      throw new Error("one batch member is inaccessible");
    },
    children: async () => [],
    project: async () => {
      throw new Error("not used by this test");
    },
  };
  const facts = nativeFacts(source, new Map(), undefined);

  expect([...(await facts.issues(["#1", "#2"]))].map(([key]) => key)).toEqual([
    "#1",
    "#2",
  ]);
  expect(singles).toEqual(["#1", "#2"]);
});

import { describe, expect, test } from "bun:test";
import {
  reconcilePreconditions,
  type TrackerIssue,
  type TrackerPort,
} from "./reconcile.ts";

function fixture(issues: TrackerIssue[] = []) {
  const calls: string[] = [];
  const port: TrackerPort = {
    async listOpen() {
      calls.push("list");
      return issues;
    },
    async create(input) {
      calls.push("create");
      return { id: "new", ...input };
    },
    async update(id, input) {
      calls.push(`update:${id}`);
      return { id, ...input };
    },
    async close(id) {
      calls.push(`close:${id}`);
    },
  };
  return { port, calls };
}
const input = {
  key: "production",
  title: "External preconditions need attention",
  body: "Protection missing",
  healthy: false,
};
const marker = "<!-- jig:external-preconditions:production -->";
const existing = {
  id: "7",
  title: input.title,
  body: `${marker}\n\n${input.body}`,
};

describe("external precondition issue reconciliation", () => {
  test("opens one issue and marks its body", async () => {
    const { port, calls } = fixture();
    const result = await reconcilePreconditions(port, input);
    expect(result.action).toBe("created");
    expect(result.issue?.body).toBe(existing.body);
    expect(calls).toEqual(["list", "create"]);
  });
  test("updates the same issue as failures change", async () => {
    const { port, calls } = fixture([existing]);
    const result = await reconcilePreconditions(port, {
      ...input,
      body: "Check unavailable",
    });
    expect(result.issue?.id).toBe("7");
    expect(result.action).toBe("updated");
    expect(calls).toEqual(["list", "update:7"]);
  });
  test("unchanged failures cause no write", async () => {
    const { port, calls } = fixture([existing]);
    expect((await reconcilePreconditions(port, input)).action).toBe(
      "unchanged",
    );
    expect(calls).toEqual(["list"]);
  });
  test("green closes the current issue", async () => {
    const { port, calls } = fixture([existing]);
    expect(
      (await reconcilePreconditions(port, { ...input, healthy: true })).action,
    ).toBe("closed");
    expect(calls).toEqual(["list", "close:7"]);
  });
  test("green with no matching issue makes no write", async () => {
    const { port, calls } = fixture([
      { ...existing, body: "A different issue" },
    ]);
    expect(
      (await reconcilePreconditions(port, { ...input, healthy: true })).action,
    ).toBe("unchanged");
    expect(calls).toEqual(["list"]);
  });
  test("duplicate markers fail before any write, even on green", async () => {
    const { port, calls } = fixture([existing, { ...existing, id: "8" }]);
    await expect(
      reconcilePreconditions(port, { ...input, healthy: true }),
    ).rejects.toThrow("multiple open issues");
    expect(calls).toEqual(["list"]);
  });
  test("unreadable listing fails before any write", async () => {
    const { port, calls } = fixture();
    port.listOpen = async () => {
      throw new Error("listing denied");
    };
    await expect(
      reconcilePreconditions(port, { ...input, healthy: true }),
    ).rejects.toThrow("listing denied");
    expect(calls).toEqual([]);
  });
  test("marker keys cannot inject markup", async () => {
    const { port, calls } = fixture();
    await expect(
      reconcilePreconditions(port, { ...input, key: "bad -->" }),
    ).rejects.toThrow("key");
    expect(calls).toEqual([]);
  });
});

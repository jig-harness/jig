import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyPreconditions } from "./check-external-preconditions.ts";
import type { TrackerPort } from "../modules/M10-environments-deploy/reference/external-preconditions/reconcile.ts";

function tracker() {
  const calls: string[] = [];
  const port: TrackerPort = {
    async listOpen() {
      calls.push("list");
      return [
        {
          id: "7",
          title: "External preconditions require attention",
          body: "<!-- jig:external-preconditions:jig-delivery -->",
        },
      ];
    },
    async create(value) {
      calls.push("create");
      return { id: "8", ...value };
    },
    async update(id, value) {
      calls.push("update");
      return { id, ...value };
    },
    async close() {
      calls.push("close");
    },
  };
  return { port, calls };
}
const fixture = readFileSync(
  join(
    import.meta.dir,
    "../modules/M10-environments-deploy/reference/external-preconditions/fixtures/registry.yaml",
  ),
  "utf8",
);
test("invalid registry maintains a red issue rather than closing it", async () => {
  const { port, calls } = tracker();
  const result = await verifyPreconditions(
    "version: 1\npreconditions: []",
    port,
    {},
  );
  expect(result.status).toBe("fail");
  expect(calls).toEqual(["list", "update"]);
});
test("unreadable live state keeps the issue open", async () => {
  const { port, calls } = tracker();
  const result = await verifyPreconditions(fixture, port, {
    "branch-protection": () => {
      throw new Error("denied");
    },
  });
  expect(result.status).toBe("fail");
  expect(calls).toEqual(["list", "update"]);
});
test("complete healthy report closes the registry issue", async () => {
  const { port, calls } = tracker();
  const result = await verifyPreconditions(fixture, port, {
    "branch-protection": () => ({ status: "pass", reasons: ["observed"] }),
  });
  expect(result.status).toBe("pass");
  expect(calls).toEqual(["list", "close"]);
});
test("tracker failures propagate even after a healthy observation", async () => {
  const { port } = tracker();
  port.close = async () => {
    throw new Error("tracker denied");
  };
  await expect(
    verifyPreconditions(fixture, port, {
      "branch-protection": () => ({ status: "pass", reasons: [] }),
    }),
  ).rejects.toThrow("tracker denied");
});

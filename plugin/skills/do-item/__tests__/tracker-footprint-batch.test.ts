import { expect, test } from "bun:test";
import { gitHub, conn } from "./github-fixtures.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { footprintBody } from "../../../shared/footprint.ts";
import { OutboundError } from "../../../shared/outbound/failure.ts";

const at = "2026-11-14T17:30:00.000Z";
const prediction = (key: string) => ({
  key,
  at,
  source: "scout" as const,
  base: "abcdef0123456789",
  paths: ["src/"],
  areas: [],
  writer: { host: "digest" },
});
const options = () => ({ cycle: {}, scopeRead: "1", cache: new Map() });
test("GitHub aliases wanted items in one bounded query and keeps later comment pages", async () => {
  const { t, calls } = gitHub((c) => {
    if (c.op === "footprint") {
      expect(c.variables).toEqual({
        b0_owner: "acme",
        b0_name: "app",
        b0_number: 1,
        b0_after: null,
        b1_owner: "acme",
        b1_name: "app",
        b1_number: 2,
        b1_after: null,
      });
      expect(c.query).toContain("b0: repository");
      expect(c.query).toContain("b1: repository");
      expect(c.query).not.toMatch(/\$(owner|number|name|after)\b/);
      return {
        b0: { issue: { id: "I1", comments: conn([], "cursor") } },
        b1: {
          issue: {
            id: "I2",
            comments: conn([
              {
                id: "C2",
                body: footprintBody(prediction("#2")),
                createdAt: at,
                authorAssociation: "MEMBER",
              },
            ]),
          },
        },
      };
    }
    expect(c.op).toBe("TrackerComments");
    expect(c.variables.after).toBe("cursor");
    return {
      repository: {
        issue: {
          id: "I1",
          comments: conn([
            {
              id: "C1",
              body: footprintBody(prediction("#1")),
              createdAt: at,
              authorAssociation: "MEMBER",
            },
          ]),
        },
      },
    };
  });
  const result = await t.footprints(
    [
      { key: "#1", labels: [] },
      { key: "#2", labels: [] },
    ],
    options(),
  );
  expect(result.get("#1")?.source).toBe("scout");
  expect(result.get("#2")?.source).toBe("scout");
  expect(calls).toHaveLength(2);
});
test("Linear batches no more than five roots and parses each through workspace trust", async () => {
  const lengths: number[] = [];
  const t = linearTracker({
    team: "ENG",
    states: parseTrackerConfig({}).states,
    transport: async (query, variables) => {
      expect(query).toContain("query footprint(");
      const keys = Object.keys(variables).filter((key) => key.endsWith("_id"));
      lengths.push(keys.length);
      return Object.fromEntries(
        keys.map((name) => {
          const alias = name.slice(0, -3),
            key = String(variables[name]);
          return [
            alias,
            {
              id: key,
              comments: conn([
                {
                  id: key,
                  body: footprintBody(prediction(key)),
                  createdAt: at,
                  user: { id: "member", guest: false },
                },
              ]),
            },
          ];
        }),
      );
    },
  });
  const items = Array.from({ length: 7 }, (_, i) => ({
    key: `ENG-${i + 1}`,
    labels: [],
  }));
  const result = await t.footprints(items, options());
  expect(lengths).toEqual([5, 2]);
  expect([...result.values()].every((v) => v.source === "scout")).toBe(true);
});
test("a partial batch is unknown for missing aliases; transport errors preserve all last readings", async () => {
  let fail = false;
  const { t, calls } = gitHub(() => {
    if (fail) throw new OutboundError("server-fault", "no answer");
    return {
      b0: {
        issue: {
          id: "I1",
          comments: conn([
            {
              id: "C1",
              body: footprintBody(prediction("#1")),
              createdAt: at,
              authorAssociation: "MEMBER",
            },
          ]),
        },
      },
    };
  });
  const o = options(),
    items = [1, 2].map((i) => ({ key: `#${i}`, labels: [], updatedAt: "1" }));
  let result = await t.footprints(items, o);
  expect(result.get("#1")?.source).toBe("scout");
  expect(result.get("#2")).toMatchObject({
    source: "unknown",
    failure: { code: "invalid" },
  });
  fail = true;
  result = await t.footprints(
    items.map((i) => ({ ...i, updatedAt: "2" })),
    { ...o, cycle: {} },
  );
  expect(result.get("#1")).toMatchObject({
    source: "scout",
    stale: true,
    failure: { code: "server-fault" },
  });
  expect(result.get("#2")).toMatchObject({
    source: "unknown",
    stale: true,
    failure: { code: "server-fault" },
  });
  expect(calls).toHaveLength(2);
});

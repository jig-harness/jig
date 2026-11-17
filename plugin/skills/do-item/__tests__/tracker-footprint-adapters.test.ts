import { expect, test } from "bun:test";
import { gitHub, conn, oneIssue, issueNode } from "./github-fixtures.ts";
import { jira, issue, comment, comments, MEMBER } from "./jira-fixtures.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { footprintBody } from "../../../shared/footprint.ts";
import { readFootprint } from "../../../shared/footprint.ts";
import { adfToMarkdown } from "../scripts/lib/tracker/jira/adf.ts";
import type { Tracker } from "../scripts/lib/tracker/port.ts";

const record = {
  key: "#42",
  at: "2026-11-14T17:30:00.000Z",
  source: "pickup" as const,
  base: "abcdef0123456789",
  paths: ["plugin/shared/"],
  areas: ["shared"],
  writer: { host: "digest" },
  pickup: "live",
};
async function read(t: Tracker, key: string) {
  return (
    await t.footprints([{ key, labels: [] }], {
      cycle: {},
      scopeRead: "1",
      cache: new Map(),
    })
  ).get(key);
}
test("GitHub footprint port reads trusted paged comments and posts a marked comment", async () => {
  let posted = "";
  const { t, calls } = gitHub((c) => {
    if (c.op === "TrackerComments")
      return {
        repository: {
          issue: {
            id: "I_42",
            comments: conn([
              {
                id: "C1",
                body: footprintBody(record),
                createdAt: record.at,
                authorAssociation: "MEMBER",
              },
              {
                id: "C2",
                body: footprintBody({
                  ...record,
                  paths: ["untrusted"],
                  at: "2026-11-15T00:00:00.000Z",
                }),
                createdAt: record.at,
                authorAssociation: "NONE",
              },
            ]),
          },
        },
      };
    if (c.op === "TrackerIssue") return oneIssue(issueNode({ number: 42 }));
    posted = String(c.variables.body);
    return { addComment: { commentEdge: { node: { id: "C3" } } } };
  });
  expect(t.footprintCommentsUpdateIssue).toBe(true);
  expect((await read(t, "#42"))?.paths).toEqual(record.paths);
  await t.writeFootprint(record);
  expect(readFootprint(posted, record.key)).toEqual(record);
  expect(calls[0]?.query).toContain("comments(first: 100");
});
test("Linear footprint port preserves trust and uses its governed comment mutation", async () => {
  let posted = "";
  const r = { ...record, key: "ENG-42" };
  const t = linearTracker({
    team: "ENG",
    states: parseTrackerConfig({}).states,
    transport: async (query, variables) => {
      if (query.includes("query TrackerComments"))
        return {
          issue: {
            id: "uuid",
            comments: conn([
              {
                id: "C1",
                body: footprintBody(r),
                createdAt: r.at,
                user: { id: "member", name: "member", guest: false },
              },
              {
                id: "C2",
                body: footprintBody({
                  ...r,
                  paths: ["untrusted"],
                  at: "2026-11-15T00:00:00.000Z",
                }),
                createdAt: r.at,
                user: { id: "guest", guest: true },
              },
            ]),
          },
        };
      if (query.includes("query TrackerIssueId"))
        return { issue: { id: "uuid", team: { id: "team", key: "ENG" } } };
      posted = String(variables.body);
      return { commentCreate: { success: true } };
    },
  });
  expect(t.footprintCommentsUpdateIssue).toBe(false);
  expect(await read(t, r.key)).toMatchObject({ paths: r.paths, stale: false });
  await t.writeFootprint(r);
  expect(readFootprint(posted, r.key)).toEqual(r);
});
test("Jira footprint port checks project membership and round trips multiline ADF", async () => {
  let posted = "";
  const r = { ...record, key: "ENG-42" };
  const { t } = jira((c) => {
    if (c.route === "GET myself") return MEMBER;
    if (c.route === "GET issue/ENG-42") return issue({ key: "ENG-42" });
    if (c.route === "GET issue/ENG-42/comment")
      return comments(
        comment("C1", footprintBody(r), MEMBER),
        comment(
          "C2",
          footprintBody({
            ...r,
            paths: ["untrusted"],
            at: "2026-11-15T00:00:00.000Z",
          }),
          { ...MEMBER, accountType: "app" },
        ),
      );
    if (c.route === "GET user/assignable/search") return [MEMBER];
    if (c.route === "POST issue/ENG-42/comment") {
      posted = adfToMarkdown(c.body.body);
      return {};
    }
    throw new Error(`unexpected ${c.route}`);
  });
  expect(t.footprintCommentsUpdateIssue).toBe(false);
  expect(await read(t, r.key)).toMatchObject({ paths: r.paths, stale: false });
  await t.writeFootprint(r);
  expect(readFootprint(posted, r.key)).toEqual(r);
});

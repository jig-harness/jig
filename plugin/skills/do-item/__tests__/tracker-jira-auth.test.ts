import { describe, expect, it } from "bun:test";
import { jiraAuthorization } from "../scripts/lib/tracker/jira/credential.ts";
import {
  httpTransport,
  httpFailure,
} from "../scripts/lib/tracker/jira/transport.ts";
import {
  GATEWAY,
  issue,
  jira,
  MEMBER,
  routes,
  tokenRun,
} from "./jira-fixtures.ts";

describe("Jira authentication before protected reads", () => {
  for (const status of [401, 403])
    it(`names the credential for HTTP ${status} at every request boundary`, () => {
      const error = httpFailure(
        status,
        new Headers(),
        "refused",
        "POST issue/ENG-1/comment",
      );
      expect(error.message).toContain("JIRA_EMAIL");
      expect(error.message).toContain("JIRA_API_TOKEN");
      expect(error.message).toContain("JIRA_BEARER_TOKEN");
      expect(error.message).toContain("JIRA_TOKEN_COMMAND");
      expect(error.message).toContain(
        "https://id.atlassian.com/manage-profile/security/api-tokens",
      );
      expect(error.unavailable).toBe(false);
    });

  for (const fields of [false, true]) {
    it(`refuses anonymous reads before ${fields ? "field resolution" : "an issue's 404"}`, async () => {
      const { client, calls } = jira(
        routes({
          "GET myself": httpFailure(
            401,
            new Headers(),
            "anonymous",
            "GET myself",
          ),
          "GET field": [{ id: "summary", name: "Summary" }],
          "GET issue/ENG-1": httpFailure(
            404,
            new Headers(),
            "hidden",
            "GET issue/ENG-1",
          ),
        }),
        fields
          ? {
              issue_tracker: { jira: { field_labels: { Product: "Product" } } },
            }
          : {},
      );
      await expect(client.issue("ENG-1")).rejects.toThrow("JIRA_API_TOKEN");
      expect(calls.map((c) => c.route)).toEqual(["GET myself"]);
    });
  }

  it("does not accept an anonymous profile served with HTTP 200", async () => {
    const { client } = jira(routes({ "GET myself": {} }));
    await expect(client.issue("ENG-1")).rejects.toThrow("JIRA_API_TOKEN");
  });

  it("verifies identity before a search can return an anonymous population", async () => {
    const { client, calls } = jira(
      routes({
        "GET myself": httpFailure(
          401,
          new Headers(),
          "anonymous",
          "GET myself",
        ),
        "POST search/jql": { issues: [], isLast: true },
      }),
    );
    await expect(client.search("project = ENG", "test search")).rejects.toThrow(
      "JIRA_API_TOKEN",
    );
    expect(calls.map((c) => c.route)).toEqual(["GET myself"]);
  });

  it("retries a refused profile without caching anonymous fields, then shares its success", async () => {
    let profiles = 0;
    const { client, calls } = jira(
      routes({
        "GET myself": () =>
          ++profiles === 1
            ? httpFailure(401, new Headers(), "anonymous", "GET myself")
            : MEMBER,
        "GET field": [
          { id: "customfield_1", name: "Product", schema: { type: "string" } },
        ],
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
      }),
      { issue_tracker: { jira: { field_labels: { Product: "Product" } } } },
    );
    await expect(client.fieldLabels()).rejects.toThrow("JIRA_API_TOKEN");
    await Promise.all([client.fieldLabels(), client.issue("ENG-1")]);
    await client.issue("ENG-1");
    expect(calls.map((c) => c.route)).toEqual([
      "GET myself",
      "GET myself",
      "GET field",
      "GET issue/ENG-1",
      "GET issue/ENG-1",
    ]);
  });

  it("lets a cancelled caller stop waiting for a shared authentication read", async () => {
    let finish!: (profile: unknown) => void;
    const profile = new Promise((resolve) => {
      finish = resolve;
    });
    const { client, calls } = jira(
      routes({
        "GET myself": () => profile,
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
      }),
    );
    const controller = new AbortController();
    const stopped = client.issue("ENG-1", controller.signal);
    controller.abort();
    await expect(stopped).rejects.toThrow();
    const continuing = client.issue("ENG-1");
    finish(MEMBER);
    await continuing;
    expect(calls.map((c) => c.route)).toEqual([
      "GET myself",
      "GET issue/ENG-1",
    ]);
  });
});

describe("Jira audit reach authentication", () => {
  for (const projectStatus of [404, 200])
    it(`refuses a credential before the project's HTTP ${projectStatus}`, async () => {
      const { t, calls } = jira(
        routes({
          "GET myself": httpFailure(
            401,
            new Headers(),
            "refused",
            "GET myself",
          ),
          "GET project/ENG":
            projectStatus === 404
              ? httpFailure(404, new Headers(), "hidden", "GET project/ENG")
              : {},
        }),
      );
      await expect(t.reach()).rejects.toThrow("JIRA_API_TOKEN");
      expect(calls.map((c) => c.route)).toEqual(["GET myself"]);
    });

  it("renews a stale command token before checking the project", async () => {
    let runs = 0;
    const auth = jiraAuthorization(
      { kind: "command", argv: ["broker"] },
      {
        runner: async () => tokenRun(++runs === 1 ? "stale" : "fresh"),
      },
    );
    const paths: string[] = [];
    const transport = httpTransport(GATEWAY, auth, (async (url, init) => {
      const path = new URL(String(url)).pathname.split("/rest/api/3/")[1];
      paths.push(String(path));
      if (new Headers(init?.headers).get("Authorization") === "Bearer stale")
        return new Response("refused", { status: 401 });
      return Response.json(path === "myself" ? MEMBER : {});
    }) as typeof fetch);
    const { t } = jira((call) =>
      transport({ method: call.method, path: call.path }),
    );
    await t.reach();
    expect(runs).toBe(2);
    expect(paths).toEqual(["myself", "myself", "project/ENG"]);
  });
});

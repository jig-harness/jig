import { describe, expect, it } from "bun:test";
import {
  httpFailure,
  JiraApiError,
} from "../scripts/lib/tracker/jira/transport.ts";
import { issue, jira, MEMBER, routes } from "./jira-fixtures.ts";

describe("Jira authentication before protected reads", () => {
  for (const status of [401, 403]) {
    it(`names the credential for HTTP ${status} without a retry classification`, async () => {
      const error = httpFailure(status, new Headers(), "refused", "GET myself");
      const { client } = jira(
        routes({ "GET myself": error, "GET issue/ENG-1": error }),
      );
      const result = await client.issue("ENG-1").catch((e: unknown) => e);
      expect(result).toBeInstanceOf(JiraApiError);
      expect((result as Error).message).toContain("JIRA_EMAIL");
      expect((result as Error).message).toContain("JIRA_API_TOKEN");
      expect((result as Error).message).toContain("JIRA_BEARER_TOKEN");
      expect((result as Error).message).toContain("JIRA_TOKEN_COMMAND");
      expect((result as Error).message).toContain(
        "https://id.atlassian.com/manage-profile/security/api-tokens",
      );
      expect((result as JiraApiError).unavailable).toBe(false);
    });
  }

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

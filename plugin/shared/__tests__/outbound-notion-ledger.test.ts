import { expect, test } from "bun:test";
import { NotionApi } from "../../skills/reflect/scripts/lib/notion/api.ts";
import { withLedgerWriter, type CallRecord } from "../outbound/ledger.ts";

test("Notion records measured request attempts without IDs or cursor values", async () => {
  const events: CallRecord[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ object: "page", id: "a" }),
  });
  try {
    const api = new NotionApi({
      token: "test-only",
      base: server.url.toString(),
      intervalMs: 0,
    });
    await withLedgerWriter(
      (e) => events.push(e),
      () => api.request("GET", "/v1/pages/customer-name?cursor=private"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      system: "notion",
      operation: "GET /v1/pages/:id",
      cost: 1,
      unit: "requests",
      failure: null,
    });
    expect(JSON.stringify(events)).not.toContain("test-only");
    expect(JSON.stringify(events)).not.toContain("customer-name");
    expect(JSON.stringify(events)).not.toContain("private");
  } finally {
    server.stop(true);
  }
});

test("a malformed Notion success body records the call's invalid failure", async () => {
  const events: CallRecord[] = [];
  const server = Bun.serve({ port: 0, fetch: () => new Response("bad JSON") });
  try {
    const api = new NotionApi({
      token: "test-only",
      base: server.url.toString(),
      intervalMs: 0,
    });
    await expect(
      withLedgerWriter(
        (e) => events.push(e),
        () => api.request("GET", "/v1/pages/item"),
      ),
    ).rejects.toThrow("JSON object");
    expect(events[0]?.failure).toBe("invalid");
  } finally {
    server.stop(true);
  }
});

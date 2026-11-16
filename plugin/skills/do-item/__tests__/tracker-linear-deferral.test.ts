import { expect, test } from "bun:test";
import {
  deferralClient,
  deferralEnvironment,
} from "../scripts/lib/tracker/linear-deferral.ts";
import { httpTransport } from "../scripts/lib/tracker/linear-transport.ts";

test("deferral uses adapter response parsing and refuses a malformed data object", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return Response.json({
      data: calls === 1 ? { issue: { id: "one" } } : null,
    });
  }) as unknown as typeof fetch;
  const client = deferralClient(httpTransport("test-token", fetchImpl));
  const signal = new AbortController().signal;
  expect(
    await client("query DeferralIssue { issue { id } }", {}, signal),
  ).toEqual({ issue: { id: "one" } });
  await expect(
    client("query DeferralIssue { issue { id } }", {}, signal),
  ).rejects.toThrow();
  expect(calls).toBe(2);
});

test("deferral forwards its whole-run abort to the adapter before sending", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  const client = deferralClient(httpTransport("test-token", fetchImpl));
  await expect(
    client("query DeferralIssue { issue { id } }", {}, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("deferral keeps its dedicated token ahead of the general API key", () => {
  expect(
    deferralEnvironment({
      LINEAR_API_TOKEN: "deferral-token",
      LINEAR_API_KEY: "general-key",
    }).LINEAR_API_KEY,
  ).toBe("deferral-token");
});

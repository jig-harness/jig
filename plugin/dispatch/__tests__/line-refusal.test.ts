import { expect, it } from "bun:test";
import { buildLine } from "../lib/line.ts";
import { input, NOW, report } from "./line-fixtures.ts";

it("keeps the failed call's class, reset and account when a failed read refuses a repository", () => {
  const refusedBy = {
    class: "rate-limited" as const,
    until: NOW,
    account: "forge-account-key",
  };
  const line = buildLine(
    input({
      reports: [
        report({ refused: "rate limit", refusedStep: "lookup", refusedBy }),
      ],
    }),
  );
  expect(line.repos[0]).toMatchObject({
    refused: "rate limit",
    refusal: { step: "lookup", failure: refusedBy },
  });
});

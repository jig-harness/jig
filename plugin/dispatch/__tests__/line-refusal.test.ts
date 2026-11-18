import { expect, it } from "bun:test";
import { buildLine } from "../lib/line.ts";
import { input, NOW, report } from "./line-fixtures.ts";

it("keeps the structured cause when a failed read refuses a repository", () => {
  const refusedBy = {
    class: "rate-limited" as const,
    until: NOW,
    account: "forge-account-key",
  };
  const line = buildLine(
    input({ reports: [report({ refused: "rate limit", refusedBy })] }),
  );
  expect(line.repos[0]).toMatchObject({ refused: "rate limit", refusedBy });
});

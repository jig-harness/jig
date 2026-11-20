import { expect, test } from "bun:test";

import type { Report } from "../scripts/lib/finish-round-report.ts";
import { pagesRead } from "../scripts/lib/driver/review-pass.ts";

const finish = (listingPagesRead: unknown): Report =>
  ({ state: "CHECK_RUNS_UNREADABLE", listingPagesRead }) as unknown as Report;

test("a finish record's page count is read only as a whole number", () => {
  expect(pagesRead(finish(3))).toBe(3);
  expect(pagesRead(finish(0))).toBe(0);
  for (const count of [2.5, "3", -1, null, undefined, Number.NaN])
    expect(pagesRead(finish(count))).toBeNull();
});

import { expect, test } from "bun:test";
import { dispatchSection } from "../lib/section.ts";

test("retired epic width is ignored and names its replacement", () => {
  const section = dispatchSection({
    dispatch: { epic_width: "old value", overlap: { max_per_file: 2 } },
  });
  expect(section.ok).toBe(true);
  if (!section.ok) return;
  expect(section.value.overlap?.maxPerFile).toBe(2);
  expect(section.value.retiredEpicWidth).toContain("dispatch.overlap");
  expect(section.value.retiredEpicWidth).toContain("dependency edges");
});

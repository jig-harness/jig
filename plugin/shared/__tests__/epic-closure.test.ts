import { expect, it } from "bun:test";
import { hasEpicWaiver } from "../epic-closure.ts";

it("recognizes a trusted waiver that records the person's reply", () => {
  const marker = "<!-- jig:epic-waiver -->";
  const body = `Epic closure accepted in <https://example.com/issues/1#reply>.\n\n${marker}`;
  expect(hasEpicWaiver([{ body, trusted: true }])).toBe(true);
  expect(hasEpicWaiver([{ body, trusted: false }])).toBe(false);
  expect(hasEpicWaiver([{ body: marker, trusted: true }])).toBe(false);
  expect(hasEpicWaiver([{ body: `${body}\nMore text`, trusted: true }])).toBe(
    false,
  );
});

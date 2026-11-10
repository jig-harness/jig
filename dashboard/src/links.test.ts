import { describe, expect, it } from "bun:test";
import { fixture } from "../fixtures.ts";
import { derivedLink, forgesOf, withDerivedLinks } from "./links.ts";

describe("the links the line tells", () => {
  const line = fixture("partial").line;
  if (line === null) throw new Error("the scenario has a line");
  const forges = forgesOf(line);

  it("work out an item's link from another item link of its repository's tracker", () => {
    expect(derivedLink("example-org/api", "#245", forges)).toBe(
      "https://forge.example/example-org/api/issues/245",
    );
    expect(derivedLink("example-org/api", "API-91", forges)).toBe(
      "https://tracker.example/acme/issue/API-91",
    );
  });

  it("work out nothing for a repository whose tracker the line holds no link of", () => {
    expect(derivedLink("example-org/docs", "WEB-3", forges)).toBeNull();
  });

  it("fill a card whose record holds no link, and leave one that does", () => {
    const linked = withDerivedLinks(line);
    const queued = (target: string) =>
      linked.queue.find((q) => q.target === target)?.url;
    expect(queued("API-93")).toBe("https://tracker.example/acme/issue/API-93");
    expect(queued("API-80")).toBe(
      "https://tracker.example/acme/issue/API-80/backfill-the-ledger",
    );
  });
});

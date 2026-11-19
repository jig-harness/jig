import { describe, expect, it } from "bun:test";
import { fixture } from "../fixtures.ts";
import { derivedLink, forgesOf, repoHome, withDerivedLinks } from "./links.ts";

describe("a repository's own page", () => {
  const web = "https://forge.example/example-org/web";

  it("comes from its pull request or its own issue", () => {
    expect(repoHome("example-org/web", `${web}/pull/7`)).toBe(web);
    expect(repoHome("example-org/web", `${web}/issues/7`)).toBe(web);
  });

  it("is not taken from an issue kept in another repository", () => {
    expect(
      repoHome(
        "example-org/web",
        "https://forge.example/example-org/tracker/issues/7",
      ),
    ).toBeNull();
  });

  it("is unknown from any other address, or none", () => {
    expect(
      repoHome("example-org/web", "https://issues.example/WEB-1"),
    ).toBeNull();
    expect(repoHome("example-org/web", null)).toBeNull();
  });
});

describe("the links the line tells", () => {
  const line = fixture("partial").line;
  if (line === null) throw new Error("the scenario has a line");
  const forges = forgesOf(line);

  it("work out an item's link from another item link of its repository's tracker", () => {
    expect(derivedLink("example-org/api", "#245", forges)).toBe(
      "https://forge.example/example-org/api/issues/245",
    );
    expect(derivedLink("example-org/api", "API-91", forges)).toBe(
      "https://issues.example/acme/issue/API-91",
    );
  });

  it("work out nothing for a repository whose tracker the line holds no link of", () => {
    expect(derivedLink("example-org/docs", "WEB-3", forges)).toBeNull();
  });

  it("fill a card whose record holds no link, and leave one that does", () => {
    const linked = withDerivedLinks(line);
    const queued = (target: string) =>
      linked.queue.find((q) => q.target === target)?.url;
    expect(queued("API-93")).toBe("https://issues.example/acme/issue/API-93");
    expect(queued("API-80")).toBe(
      "https://issues.example/acme/issue/API-80/backfill-the-ledger",
    );
  });
});

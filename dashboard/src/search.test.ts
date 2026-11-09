import { describe, expect, it } from "bun:test";
import {
  applyPatch,
  type LogFilter,
  pageQuery,
  readFilter,
  rowsQuery,
  tokenOf,
  viewOf,
  openingView,
  VIEWS,
  viewQuery,
  withParam,
} from "./search.ts";

const NONE: LogFilter = readFilter("");

describe("the query string", () => {
  it("reads today when it names no window, and today for a window it does not know", () => {
    expect(readFilter("").window).toBe("today");
    expect(readFilter("?window=forever").window).toBe("today");
    expect(readFilter("?window=30d").window).toBe("30d");
  });

  it("reads each filter, a space as a plus", () => {
    expect(
      readFilter(
        "?window=30d&repo=example-org/web&class=gates+failed&reason=conflict&stage=rearm&account=work-a",
      ),
    ).toEqual({
      window: "30d",
      from: "",
      to: "",
      repo: "example-org/web",
      stage: "rearm",
      account: "work-a",
      class: "gates failed",
      reason: "conflict",
    });
  });

  it("reads a range over a window", () => {
    const filter = readFilter("?window=7d&from=2026-11-03T04:00");
    expect(filter.window).toBe("range");
    expect(filter.from).toBe("2026-11-03T04:00");
  });

  it("writes what it read, in the form the page shows", () => {
    const query =
      "?window=30d&repo=example-org/web&class=gates+failed&reason=conflict";
    expect(viewQuery(readFilter(query))).toBe(query);
  });

  it("writes a range without a window", () => {
    expect(
      viewQuery(
        applyPatch(NONE, { from: "2026-11-03T04:00", to: "2026-11-03T05:00" }),
      ),
    ).toBe("?from=2026-11-03T04:00&to=2026-11-03T05:00");
  });

  it("keeps the token and the theme, and nothing else it was opened with", () => {
    expect(
      pageQuery(applyPatch(NONE, { window: "7d" }), "?token=t&theme=dark&x=1"),
    ).toBe("?token=t&theme=dark&window=7d");
  });

  it("encodes what would change the address's meaning", () => {
    const query = viewQuery(applyPatch(NONE, { reason: "a&b=c #d" }));
    expect(query).toBe("?window=today&reason=a%26b%3Dc+%23d");
    expect(readFilter(query).reason).toBe("a&b=c #d");
  });
});

describe("a change of filter", () => {
  it("ends a range when a preset is picked", () => {
    const ranged = applyPatch(NONE, { from: "2026-11-03T04:00", to: "x" });
    expect(applyPatch(ranged, { window: "7d" })).toMatchObject({
      window: "7d",
      from: "",
      to: "",
    });
  });

  it("ends a preset when a range is typed", () => {
    const seven = applyPatch(NONE, { window: "7d" });
    expect(applyPatch(seven, { from: "2026-11-03T04:00" }).window).toBe(
      "range",
    );
  });

  it("leaves the rest alone", () => {
    const filtered = applyPatch(NONE, { repo: "example-org/web" });
    expect(applyPatch(filtered, { class: "stalled" })).toMatchObject({
      repo: "example-org/web",
      class: "stalled",
    });
  });
});

describe("what goes to the server", () => {
  it("sends a typed range as instants in the host's zone", () => {
    const filter = applyPatch(NONE, {
      from: "2026-07-01T12:00",
      to: "2026-07-01T13:00",
    });
    expect(rowsQuery(filter, "America/New_York")).toBe(
      "from=2026-07-01T16:00:00.000Z&to=2026-07-01T17:00:00.000Z",
    );
  });

  it("sends a time that already names its offset as it is", () => {
    const filter = applyPatch(NONE, { from: "2026-07-01T16:00:00.000Z" });
    expect(rowsQuery(filter, "America/New_York")).toBe(
      "from=2026-07-01T16:00:00.000Z",
    );
  });

  it("leaves a named window alone, with or without a zone", () => {
    const filter = applyPatch(NONE, { window: "7d", repo: "example-org/web" });
    expect(rowsQuery(filter, null)).toBe("window=7d&repo=example-org/web");
    expect(rowsQuery(filter, "UTC")).toBe("window=7d&repo=example-org/web");
  });
});

describe("what the page was opened with", () => {
  it("reads its token", () => {
    expect(tokenOf("?token=abc&window=7d")).toBe("abc");
    expect(tokenOf("")).toBe("");
  });

  it("reads its view, and none when it names none it knows", () => {
    expect(viewOf("?token=t&view=history")).toBe("history");
    expect(viewOf("?view=help")).toBe("help");
    expect(viewOf("?view=constructor")).toBeNull();
    expect(viewOf("?view=toString")).toBeNull();
    expect(viewOf("?view=merge")).toBe("merge");
    expect(viewOf("?view=other")).toBeNull();
    expect(viewOf("")).toBeNull();
  });

  it("reads the old Now as Needs you", () => {
    expect(viewOf("?view=now")).toBe("needs");
  });

  it("opens on Merge while merge now holds anything, else on Needs you", () => {
    expect(openingView(2)).toBe("merge");
    expect(openingView(0)).toBe("needs");
  });

  it("gives every view but Help a key after g, each its own", () => {
    const keys = VIEWS.flatMap((v) => (v.key === null ? [] : [v.key]));
    expect(keys).toEqual(["m", "n", "r", "q", "h"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("one parameter changed in place", () => {
  it("replaces decoded names and keeps unrelated bytes intact", () => {
    expect(
      withParam("?%76iew=help&token=a%2Fb&view=now", "view", "history"),
    ).toBe("?token=a%2Fb&view=history");
    expect(withParam("?%74heme=dark", "theme", "light")).toBe("?theme=light");
  });
  it("sets it and keeps every other pair as written", () => {
    expect(withParam("?token=t&repo=example-org/web", "view", "history")).toBe(
      "?token=t&repo=example-org/web&view=history",
    );
  });

  it("replaces a value it already has", () => {
    expect(withParam("?view=help&token=t", "view", "history")).toBe(
      "?token=t&view=history",
    );
  });

  it("leaves it out for null, and the whole query when nothing is left", () => {
    expect(withParam("?token=t&view=help", "view", null)).toBe("?token=t");
    expect(withParam("?view=help", "view", null)).toBe("");
  });

  it("keeps the view when the filter changes", () => {
    expect(
      pageQuery(applyPatch(NONE, { window: "7d" }), "?token=t&view=history"),
    ).toBe("?token=t&view=history&window=7d");
  });
});

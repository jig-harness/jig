import { describe, expect, it } from "bun:test";
import { sendRefusal, tokenRefusal } from "./github.ts";
import { sendTargetOf } from "./send-target.ts";

const PARKED = {
  repo: "example-org/web",
  pr: 502,
  url: "https://github.com/example-org/web/pull/502",
  parked: true,
};

describe("where a card's Send posts", () => {
  it("is a parked drive's pull request on github.com", () => {
    expect(sendTargetOf(PARKED)).toEqual({
      to: { repo: "example-org/web", number: 502 },
    });
    // GitHub's names are not case-sensitive.
    expect(
      sendTargetOf({
        ...PARKED,
        url: "https://github.com/Example-Org/Web/pull/502",
      }),
    ).toEqual({ to: { repo: "example-org/web", number: 502 } });
  });

  it("is nowhere for a card no drive reads an answer comment for", () => {
    for (const need of [
      { ...PARKED, parked: false },
      { ...PARKED, pr: null },
    ])
      expect(sendTargetOf(need)).toEqual({
        absent: expect.stringContaining("only a drive's parked decisions"),
      });
  });

  it("is nowhere off github.com, or when the link names another pull request", () => {
    expect(
      sendTargetOf({
        ...PARKED,
        url: "https://forge.example/example-org/web/pull/502",
      }),
    ).toEqual({
      absent: expect.stringContaining(
        "github.com only, and this pull request is at forge.example",
      ),
    });
    expect(sendTargetOf({ ...PARKED, url: null })).toEqual({
      absent: expect.stringContaining("no link to this pull request"),
    });
    for (const url of [
      "https://github.com/example-org/api/pull/502",
      "https://github.com/example-org/web/pull/5020",
      "https://github.com/example-org/web/pull/502/files",
    ])
      expect("absent" in sendTargetOf({ ...PARKED, url })).toBe(true);
  });
});

describe("what a refusal from GitHub says", () => {
  const to = { repo: "example-org/web", number: 502 };

  it("names the status, GitHub's message and what to do", () => {
    expect(
      sendRefusal({ status: 401, message: "Bad credentials" }, to),
    ).toContain("401: Bad credentials");
    expect(sendRefusal({ status: 403, message: "Forbidden" }, to)).toContain(
      "read and write access to Issues and Pull requests on example-org/web",
    );
    expect(sendRefusal({ status: 404, message: "Not Found" }, to)).toContain(
      "the token was not granted example-org/web",
    );
    expect(
      sendRefusal({ status: 422, message: "Validation Failed" }, to),
    ).toContain("422: Validation Failed");
    for (const status of [401, 403, 404, 410, 422])
      expect(sendRefusal({ status, message: "m" }, to)).toContain(
        "nothing was posted",
      );
  });

  it("never says nothing was posted when no answer came back", () => {
    const said = sendRefusal({ status: null, message: "Failed to fetch" }, to);
    expect(said).not.toContain("nothing was posted");
    expect(said).toContain("check before sending again");
    expect(
      sendRefusal({ status: 502, message: "Bad Gateway" }, to),
    ).not.toContain("nothing was posted");
  });

  it("explains a refused token test", () => {
    expect(tokenRefusal({ status: 401, message: "Bad credentials" })).toContain(
      "mistyped, expired or revoked",
    );
    expect(tokenRefusal({ status: null, message: "offline" })).toContain(
      "could not be reached",
    );
  });
});

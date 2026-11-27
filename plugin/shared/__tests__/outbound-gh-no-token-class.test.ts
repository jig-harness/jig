import { describe, expect, it } from "bun:test";
import { type GhRun, ghRunFailure } from "../outbound/github.ts";

const run = (stderr: string): GhRun => ({
  code: 1,
  stderr,
  timedOut: false,
});

describe("a forge client that refuses to run for want of a token for its account", () => {
  // The refusals of a client that picks its account by repository and has no
  // token stored for the one a call addresses: the credential is missing, so
  // the call is `unauthorized`, never `invalid` (which is a defect).
  for (const said of [
    "gh: no example-account token in gh's hosts.yml; refusing to run as another account",
    "gh: no other-account token in gh's hosts.yml; refusing to run as another account (see its documentation)",
    "refusing to run as another account",
  ])
    it(`is unauthorized: ${said}`, () => {
      expect(ghRunFailure(run(said))?.code).toBe("unauthorized");
    });

  it("leaves an answer it does not know `invalid`", () => {
    expect(ghRunFailure(run("gh: something unforeseen"))?.code).toBe("invalid");
  });
});

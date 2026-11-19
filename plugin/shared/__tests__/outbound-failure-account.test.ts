import { describe, expect, it } from "bun:test";
import { OutboundError } from "../outbound/failure.ts";
import { GitHubApiError } from "../../skills/do-item/scripts/lib/tracker/github/transport.ts";

describe("a failure's account through the exception", () => {
  it("keeps the account on an OutboundError and its failure", () => {
    const error = new OutboundError("unauthorized", "refused", {
      account: "key-1",
    });
    expect(error.account).toBe("key-1");
    expect(error.failure.account).toBe("key-1");
  });

  it("keeps the account on the GitHub adapter's error", () => {
    const error = new GitHubApiError("refused", {
      code: "unauthorized",
      account: "key-1",
    });
    expect(error.failure.account).toBe("key-1");
  });

  it("carries no account when none was given", () => {
    expect(
      new OutboundError("unauthorized", "refused").failure.account,
    ).toBeUndefined();
  });
});

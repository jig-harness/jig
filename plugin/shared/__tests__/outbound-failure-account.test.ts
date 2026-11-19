import { describe, expect, it } from "bun:test";
import { OutboundError, outboundFailure } from "../outbound/failure.ts";
import {
  GitHubApiError,
  unwrapResponse,
} from "../../skills/do-item/scripts/lib/tracker/github/transport.ts";

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

  it("keeps the run's account when GraphQL errors rebuild the failure", () => {
    const failure = outboundFailure("rate-limited", "spent", {
      account: "key-1",
    });
    try {
      unwrapResponse({ errors: [{ message: "boom" }] }, failure);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as GitHubApiError).failure.account).toBe("key-1");
    }
  });
});

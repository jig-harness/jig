import { ok as assert } from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fixture } from "../fixtures.ts";
import { confirmationSignature } from "./confirmation.ts";
import { tokensFrom } from "./forge-token.ts";
import { needView } from "./needs-view.ts";
import { rowAnswer } from "./picking.ts";
import { NoSendReason } from "./send.tsx";
import {
  credentialOf,
  type KeptToken,
  ownerOf,
  parseOwners,
  tokenFor,
  withoutToken,
  withOwners,
  withToken,
} from "./token-owners.ts";

const A: KeptToken = {
  token: "pat-a",
  login: "maintainer-a",
  at: 1,
  owners: ["example-org"],
};
const B: KeptToken = {
  token: "pat-b",
  login: "helper-b",
  at: 2,
  owners: ["second-org", "third-org"],
};
const ANY: KeptToken = { token: "pat-c", login: "other-c", at: 3, owners: [] };

function refusal(answer: { ok: true } | { ok: false; reason: string }) {
  return answer.ok ? null : answer.reason;
}

describe("which kept token answers for a repository", () => {
  test("the token naming the target's owner, compared without case", () => {
    expect(ownerOf("Second-Org/site")).toBe("Second-Org");
    expect(tokenFor([A, B], "Second-Org")?.login).toBe("helper-b");
    expect(tokenFor([A, B], "EXAMPLE-ORG")?.login).toBe("maintainer-a");
  });

  test("an owner no token names takes the token that names none, else none", () => {
    expect(tokenFor([A, B, ANY], "fourth-org")?.login).toBe("other-c");
    expect(tokenFor([A, B, ANY], "example-org")?.login).toBe("maintainer-a");
    expect(tokenFor([A, B], "fourth-org")).toBeNull();
    expect(tokenFor([], "example-org")).toBeNull();
  });
});

describe("the owners a person names for a token", () => {
  test("takes owners and owner/* alike, by commas or spaces, once each", () => {
    expect(
      parseOwners(" example-org, Second-Org/*  second-org third "),
    ).toEqual({ ok: true, value: ["example-org", "Second-Org", "third"] });
    expect(parseOwners("")).toEqual({ ok: true, value: [] });
  });

  test("refuses a repository and a name GitHub could not hold", () => {
    expect(refusal(parseOwners("example-org/web"))).toContain(
      "example-org rather than example-org/web",
    );
    expect(refusal(parseOwners("not_an owner"))).toContain("not_an");
  });
});

describe("keeping several tokens", () => {
  test("a token for another account is kept beside the others", () => {
    const kept = withToken([A], B, B.owners);
    expect(kept).toEqual({ ok: true, value: [A, B] });
  });

  test("an owner another token names is refused, without case", () => {
    expect(refusal(withToken([A], B, ["Example-Org"]))).toContain(
      "Example-Org already answers through maintainer-a's token",
    );
    expect(refusal(withOwners([A, B], "helper-b", ["example-org"]))).toContain(
      "example-org already answers through maintainer-a's token",
    );
  });

  test("a second token that names no owner is refused", () => {
    expect(refusal(withToken([A, ANY], B, []))).toContain(
      "other-c's token already answers for every owner no other token names",
    );
    expect(refusal(withOwners([B, ANY], "helper-b", []))).toContain(
      "other-c's token already answers",
    );
  });

  test("a token for a kept account replaces it and keeps its owners unless others are named", () => {
    const again = { ...A, token: "pat-a2", at: 9, owners: [] };
    expect(withToken([A, B], again, [])).toEqual({
      ok: true,
      value: [{ ...again, owners: ["example-org"] }, B],
    });
    expect(withToken([A, B], again, ["fourth-org"])).toEqual({
      ok: true,
      value: [{ ...again, owners: ["fourth-org"] }, B],
    });
  });

  test("remapping moves an owner from one token to another", () => {
    const freed = withOwners([A, B], "helper-b", ["second-org"]);
    assert(freed.ok);
    const moved = withOwners(freed.value, "maintainer-a", [
      "example-org",
      "third-org",
    ]);
    assert(moved.ok);
    expect(tokenFor(moved.value, "third-org")?.login).toBe("maintainer-a");
  });
});

describe("a confirmation holds for the token that answers the card", () => {
  const source = fixture("picks").line?.needs[0];
  assert(source);
  const at = (repo: string) => {
    const n = needView(
      { ...source, repo, url: `https://github.com/${repo}/pull/501` },
      { nowMs: 0, timeZone: "UTC" },
    );
    const row = n.rows[0];
    assert(row);
    return (tokens: KeptToken[]) =>
      confirmationSignature(
        n,
        [rowAnswer(row, null)],
        credentialOf(tokenFor(tokens, ownerOf(repo))),
      );
  };
  const exampleCard = at("example-org/web");
  const secondCard = at("second-org/site");

  test("forgetting one token resets only the cards it answered", () => {
    const after = withoutToken([A, B], "maintainer-a");
    expect(after).toEqual([B]);
    expect(secondCard(after)).toBe(secondCard([A, B]));
    expect(exampleCard(after)).not.toBe(exampleCard([A, B]));
  });

  test("replacing one token resets only the cards it answered", () => {
    const replaced = withToken([A, B], { ...A, token: "pat-a2", at: 9 }, []);
    assert(replaced.ok);
    expect(secondCard(replaced.value)).toBe(secondCard([A, B]));
    expect(exampleCard(replaced.value)).not.toBe(exampleCard([A, B]));
  });

  test("remapping a card's owner to another token resets it", () => {
    const remapped = withOwners([A, B], "maintainer-a", []);
    assert(remapped.ok);
    const moved = withOwners(remapped.value, "helper-b", [
      "second-org",
      "third-org",
      "example-org",
    ]);
    assert(moved.ok);
    expect(exampleCard(moved.value)).not.toBe(exampleCard([A, B]));
  });
});

describe("what a browser has stored", () => {
  test("the single token of the earlier shape stays kept and answers for every owner", () => {
    const tokens = tokensFrom(null, {
      token: "pat-a",
      login: "maintainer-a",
      at: 1,
    });
    expect(tokens).toEqual([
      { token: "pat-a", login: "maintainer-a", at: 1, owners: [] },
    ]);
    expect(tokenFor(tokens, "any-owner")?.login).toBe("maintainer-a");
  });

  test("the list of tokens is read before the earlier shape, and what is not a token is dropped", () => {
    expect(
      tokensFrom(
        {
          tokens: [
            A,
            { ...B, owners: ["second-org", 7] },
            { token: "", login: "x", at: 1, owners: [] },
            { ...A, token: "pat-dup" },
          ],
        },
        { token: "pat-old", login: "old", at: 1 },
      ),
    ).toEqual([A, { ...B, owners: ["second-org"] }]);
    expect(tokensFrom(null, null)).toEqual([]);
  });
});

describe("a card whose owner no kept token answers for", () => {
  const n = fixture("loud").line?.needs[0];
  assert(n);
  const need = {
    ...needView(n, { nowMs: 0, timeZone: "UTC" }),
    send: { to: { repo: "third-org/tools", number: 17 } },
  };

  test("names the owner with no token and points at the settings", () => {
    const said = renderToStaticMarkup(
      <NoSendReason need={need} tokens={[A]} fault={null} />,
    );
    expect(said).toContain("No Send here");
    expect(said).toContain("third-org");
    expect(said).toContain("Send settings");
  });

  test("says nothing when a token answers for it", () => {
    expect(
      renderToStaticMarkup(
        <NoSendReason need={need} tokens={[A, B]} fault={null} />,
      ),
    ).toBe("");
  });
});

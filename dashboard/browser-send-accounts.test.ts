import { ok as assert } from "node:assert/strict";
/**
 * Send with a token per GitHub account, in a real browser against the real
 * server, with GitHub's API answered by the test: each card posts with the
 * token that names its repository's owner, and the confirmation and the
 * result name that token's login; a card whose owner no token names has no
 * Send, says so, and still copies; the settings panel refuses a second token
 * for one owner and a second token for every owner; forgetting or replacing
 * one token in another tab keeps the rest and ends the confirmation only on
 * the cards it answered; and a browser holding the single token of the
 * earlier storage shape keeps it. No token reaches the dashboard's server.
 */
import { describe, expect } from "bun:test";
import type { LineNeed } from "../plugin/dispatch/lib/dashboard-contract.ts";
import { settled, shows, until } from "./browser-page.ts";
import {
  card,
  clipboard,
  EARLIER_KEY,
  expectTokenOnlyToGithub,
  GITHUB_TOKEN,
  kept,
  type Opened,
  posts,
  sendOpener,
} from "./browser-send-page.ts";
import { browserSuite, TIMEOUT } from "./browser-suite.ts";
import { PICK_DIGESTS } from "./fixture-picks.ts";
import { fixture } from "./fixtures.ts";

const suite = await browserSuite();
const { browserIt } = suite;
const openSend = sendOpener(suite);

const TOKEN_A = GITHUB_TOKEN;
const TOKEN_B = "github_pat_0123456789abcdefSECONDORG";
const TOKEN_B2 = "github_pat_0123456789abcdefSECONDNEW";
const TOKEN_C = "github_pat_0123456789abcdefTHIRDACCT";
const TOKEN_D = "github_pat_0123456789abcdefFOURTHACT";
const TOKENS = [TOKEN_A, TOKEN_B, TOKEN_B2, TOKEN_C, TOKEN_D];
const LOGINS = {
  [TOKEN_A]: "maintainer-a",
  [TOKEN_B]: "helper-b",
  [TOKEN_B2]: "helper-b",
  [TOKEN_C]: "third-c",
  [TOKEN_D]: "fourth-d",
};

/** The picks scenario's one-decision card, at PR #501 of example-org, and the same card under two other owners. */
function ownersNeeds(): LineNeed[] {
  const base = fixture("picks").line?.needs.find((n) => n.pr === 501);
  assert(base);
  const at = (repo: string, pr: number): LineNeed => ({
    ...base,
    repo,
    pr,
    target: `PR #${pr}`,
    url: `https://github.com/${repo}/pull/${pr}`,
  });
  return [base, at("second-org/site", 601), at("third-org/tools", 701)];
}

const APPROVE = `answer PRRT_one: approve [${PICK_DIGESTS.one}]`;

function settingsText(opened: Opened): Promise<string> {
  return opened.page
    .locator(".sendSettings")
    .textContent()
    .then((t) => t ?? "");
}

/** Pastes a token and the owners it answers for in the open settings panel, then Test and keep. */
async function keepToken(
  opened: Opened,
  token: string,
  owners: string,
): Promise<void> {
  const { page } = opened;
  await page.getByLabel("GitHub token").fill(token);
  await page.getByLabel("Owners it answers for").fill(owners);
  const before = opened.calls.length;
  await page.getByRole("button", { name: "Test and keep" }).click();
  await until(
    "GitHub was asked who the token is",
    async () =>
      opened.calls.length > before &&
      (await page.getByRole("button", { name: "Testing…" }).count()) === 0,
  );
}

/** Picks Keep it on a card and presses Send, so its confirmation shows. */
async function armSend(opened: Opened, target: string, login: string) {
  const item = card(opened.page, target);
  await item.locator(".opt", { hasText: "Keep it" }).click();
  await item
    .getByRole("button", { name: `Send the answers for ${target} as ${login}` })
    .click();
  await until(
    `${target} asks to confirm`,
    async () => (await item.locator(".guard").count()) === 1,
  );
  return item;
}

describe("Send with a token per account", () => {
  browserIt(
    "each card posts with the token for its repository's owner, named in the confirmation and the result, and an owner with no token copies",
    async () => {
      const opened = await openSend("picks", {
        needs: ownersNeeds(),
        logins: LOGINS,
      });
      const { page } = opened;
      try {
        await page.getByRole("button", { name: "Send from here" }).click();
        await keepToken(opened, TOKEN_A, "example-org");
        await keepToken(opened, TOKEN_B, "Second-Org/*");
        const said = await settingsText(opened);
        expect(said).toContain("posts as maintainer-a");
        expect(said).toContain("posts as helper-b");
        expect(said).toContain("No kept token answers for third-org");
        expect(
          await page
            .getByRole("button", { name: "Sending as maintainer-a, helper-b" })
            .count(),
        ).toBe(1);
        await page.getByRole("button", { name: "Close" }).click();

        for (const [target, login] of [
          ["PR #501", "maintainer-a"],
          ["PR #601", "helper-b"],
        ] as const) {
          const item = await armSend(opened, target, login);
          expect(await item.locator(".guard").textContent()).toContain(
            `as ${login}?`,
          );
          await item
            .getByRole("button", {
              name: `Confirm and send the answers for ${target} as ${login}`,
            })
            .click();
          await until(`${target} says it was sent`, async () =>
            ((await item.locator(".sentHere").textContent()) ?? "").includes(
              `Sent here as ${login}`,
            ),
          );
        }
        expect(
          posts(opened.calls).map((p) => ({
            path: p.path,
            authorization: p.authorization,
            writer: p.record?.writer,
          })),
        ).toEqual([
          {
            path: "/repos/example-org/web/issues/501/comments",
            authorization: `Bearer ${TOKEN_A}`,
            writer: { login: "maintainer-a", host: "dashboard (browser)" },
          },
          {
            path: "/repos/second-org/site/issues/601/comments",
            authorization: `Bearer ${TOKEN_B}`,
            writer: { login: "helper-b", host: "dashboard (browser)" },
          },
        ]);

        const third = card(page, "PR #701");
        expect(await third.locator(".copy.send").count()).toBe(0);
        expect(await third.locator(".noSend").textContent()).toContain(
          "none of the tokens kept in this browser answers for third-org",
        );
        await third
          .getByRole("button", { name: "Copy the approval for PR #701" })
          .click();
        await until(
          "Copy copied",
          async () => (await clipboard(page)) === APPROVE,
        );
        expectTokenOnlyToGithub(opened, TOKENS);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the settings panel refuses a second token for one owner and a second token for every owner",
    async () => {
      const opened = await openSend("picks", {
        needs: ownersNeeds(),
        logins: LOGINS,
        tokens: [
          { token: TOKEN_A, login: "maintainer-a", owners: ["example-org"] },
          { token: TOKEN_B, login: "helper-b", owners: ["second-org"] },
        ],
      });
      const { page } = opened;
      const logins = async () =>
        ((await kept(page)) ?? []).map((t) =>
          typeof t === "object" && t !== null && "login" in t ? t.login : t,
        );
      try {
        await page
          .getByRole("button", { name: "Sending as maintainer-a, helper-b" })
          .click();
        await keepToken(opened, TOKEN_C, "EXAMPLE-ORG");
        expect(await settingsText(opened)).toContain(
          "EXAMPLE-ORG already answers through maintainer-a's token",
        );
        expect(await logins()).toEqual(["maintainer-a", "helper-b"]);

        await page
          .getByRole("textbox", { name: "Owners helper-b's token answers for" })
          .fill("second-org, example-org");
        await page
          .getByRole("button", {
            name: "Save the owners helper-b's token answers for",
          })
          .click();
        await until("the remap is refused", async () =>
          (await settingsText(opened)).includes(
            "example-org already answers through maintainer-a's token",
          ),
        );
        expect(
          await card(page, "PR #501")
            .getByRole("button", {
              name: "Send the answers for PR #501 as maintainer-a",
            })
            .count(),
        ).toBe(1);

        // One token may answer for every owner no other names; a second may not.
        await keepToken(opened, TOKEN_C, "");
        await until("third-c is kept", async () =>
          (await settingsText(opened)).includes("posts as third-c"),
        );
        expect(await settingsText(opened)).toContain(
          "every owner no other token names",
        );
        await keepToken(opened, TOKEN_D, "");
        expect(await settingsText(opened)).toContain(
          "third-c's token already answers for every owner no other token names",
        );
        expect(await logins()).toEqual(["maintainer-a", "helper-b", "third-c"]);
        await page.getByRole("button", { name: "Close" }).click();
        expect(
          await card(page, "PR #701")
            .getByRole("button", {
              name: "Send the answers for PR #701 as third-c",
            })
            .count(),
        ).toBe(1);
        expectTokenOnlyToGithub(opened, TOKENS);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "forgetting or replacing one token in another tab keeps the others and ends the confirmation only on the cards it answered",
    async () => {
      const opened = await openSend("picks", {
        needs: ownersNeeds(),
        logins: LOGINS,
        tokens: [
          { token: TOKEN_A, login: "maintainer-a", owners: ["example-org"] },
          { token: TOKEN_B, login: "helper-b", owners: ["second-org"] },
        ],
      });
      const { page } = opened;
      try {
        const second = await armSend(opened, "PR #601", "helper-b");
        const other = await opened.another();
        await other
          .getByRole("button", { name: "Sending as maintainer-a, helper-b" })
          .click();
        await other
          .getByRole("button", { name: "Forget the token for maintainer-a" })
          .click();

        const first = card(page, "PR #501");
        await until("example-org's card lost Send", async () =>
          first
            .locator(".copy.send")
            .count()
            .then((n) => n === 0),
        );
        expect(await first.locator(".noSend").textContent()).toContain(
          "answers for example-org",
        );
        expect(await second.locator(".guard").count()).toBe(1);
        await second
          .getByRole("button", {
            name: "Confirm and send the answers for PR #601 as helper-b",
          })
          .click();
        await until(
          "the confirmed answer posted",
          async () => posts(opened.calls).length === 1,
        );
        expect(posts(opened.calls)[0]?.authorization).toBe(`Bearer ${TOKEN_B}`);

        // Replacing helper-b's token ends the confirmation of the card it answers.
        await armSend(opened, "PR #601", "helper-b");
        await other.getByLabel("GitHub token").fill(TOKEN_B2);
        await other.getByRole("button", { name: "Test and keep" }).click();
        await until(
          "the confirmation ended",
          async () => (await second.locator(".guard").count()) === 0,
        );
        const now = (await kept(page)) ?? [];
        expect(now).toEqual([
          expect.objectContaining({
            token: TOKEN_B2,
            login: "helper-b",
            owners: ["second-org"],
          }),
        ]);
        expectTokenOnlyToGithub(opened, TOKENS);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a browser holding the single token of the earlier shape keeps it for every owner, beside a token it adds",
    async () => {
      const opened = await openSend("picks", {
        needs: ownersNeeds(),
        logins: LOGINS,
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      try {
        for (const target of ["PR #501", "PR #601", "PR #701"])
          expect(
            await card(page, target)
              .getByRole("button", {
                name: `Send the answers for ${target} as maintainer-a`,
              })
              .count(),
          ).toBe(1);
        await page
          .getByRole("button", { name: "Sending as maintainer-a" })
          .click();
        expect(await settingsText(opened)).toContain(
          "posts as maintainer-a, the login GitHub named for the token, and answers for every owner no other token names",
        );
        await keepToken(opened, TOKEN_B, "second-org");
        await until("helper-b is kept", async () =>
          (await settingsText(opened)).includes("posts as helper-b"),
        );
        expect(await kept(page)).toEqual([
          expect.objectContaining({
            token: TOKEN_A,
            login: "maintainer-a",
            owners: [],
          }),
          expect.objectContaining({
            token: TOKEN_B,
            login: "helper-b",
            owners: ["second-org"],
          }),
        ]);
        expect(
          await page.evaluate((key) => localStorage.getItem(key), EARLIER_KEY),
        ).toBeNull();

        await page.reload();
        await shows(page, ".pNeeds .need");
        await settled(page);
        for (const [target, login] of [
          ["PR #501", "maintainer-a"],
          ["PR #601", "helper-b"],
          ["PR #701", "maintainer-a"],
        ] as const)
          expect(
            await card(page, target)
              .getByRole("button", {
                name: `Send the answers for ${target} as ${login}`,
              })
              .count(),
          ).toBe(1);
        expectTokenOnlyToGithub(opened, TOKENS);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );
});

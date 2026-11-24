import { ok as assert } from "node:assert/strict";
/**
 * Send in a real browser against the real server, with GitHub's API answered
 * by the test: with no token kept no card has Send; the settings panel tests a
 * pasted token with GitHub, names its login and forgets it; Send waits for an
 * option to be picked, then posts each decision's lines Copy takes as its own
 * comment carrying the `drive-answer` record, and the card says it was sent
 * here; a guarded pick sends only on the second step; GitHub's refusals
 * are explained; a card no drive reads an answer comment for says why it has
 * no Send; and at phone widths, by touch alone, it all works with no
 * horizontal scroll and 44 px targets. The token never reaches the
 * dashboard's server. How the browser is found and when its absence fails is
 * `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { LineNeed } from "../plugin/dispatch/lib/dashboard-contract.ts";
import { decisionOf } from "../plugin/dispatch/lib/line-decision.ts";
import {
  frameStationDecision,
  type StationFacts,
} from "../plugin/shared/decisions/station.ts";
import { dispatcherDecisionDigest } from "../plugin/shared/decisions/station-digest.ts";
import { parseAnswerComment } from "../plugin/skills/drive-pr/scripts/lib/answer-forms.ts";
import { stationItem } from "../plugin/dispatch/lib/station-answers.ts";
import { fixture } from "./fixtures.ts";
import { PICK_DIGESTS } from "./fixture-picks.ts";
import { settled, shortControls, shows, until } from "./browser-page.ts";
import {
  type FakeAnswer,
  card,
  clipboard,
  EARLIER_KEY,
  expectTokenOnlyToGithub,
  GITHUB_TOKEN,
  kept,
  noSideScroll,
  posts,
  sendOpener,
  showAll,
} from "./browser-send-page.ts";
import { browserSuite, PHONE, TIMEOUT } from "./browser-suite.ts";

const suite = await browserSuite();
const { browserIt } = suite;
const openSend = sendOpener(suite);

const NARROW = { width: 320, height: 568 };
const BEFORE = "the clipboard before";

const TWO = [
  `answer PRRT_flag: choose Remove [${PICK_DIGESTS.flag}]`,
  "",
  `answer PRRT_table: approve [${PICK_DIGESTS.table}]`,
].join("\n");

describe("Send", () => {
  browserIt(
    "with no token kept no card has Send, nothing calls GitHub, and the head offers it",
    async () => {
      const opened = await openSend("picks");
      try {
        const { page } = opened;
        expect(await page.locator(".copy.send").count()).toBe(0);
        expect(await page.locator(".noSend").first().textContent()).toContain(
          "Paste a GitHub token",
        );
        await page.getByRole("button", { name: "Send from here" }).click();
        await shows(page, ".sendSettings");
        expect(await page.locator(".sendSettings").textContent()).toContain(
          "example-org/api, example-org/web",
        );
        expect(opened.calls).toEqual([]);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the settings panel tests a pasted token with GitHub, names its login, keeps it here alone and forgets it",
    async () => {
      const opened = await openSend("picks", {
        github: (call) =>
          call.authorization === "Bearer wrong"
            ? { status: 401, json: { message: "Bad credentials" } }
            : { status: 200, json: { login: "maintainer-a" } },
      });
      const { page } = opened;
      try {
        await page.getByRole("button", { name: "Send from here" }).click();
        const field = page.getByLabel("GitHub token");
        await field.fill("wrong");
        await page.getByRole("button", { name: "Test and keep" }).click();
        await until("the refusal shows", async () =>
          ((await page.locator(".sendSettings").textContent()) ?? "").includes(
            "401: Bad credentials",
          ),
        );
        expect(await kept(page)).toBeNull();
        expect(await page.locator(".copy.send").count()).toBe(0);

        await field.fill(GITHUB_TOKEN);
        await field.press("Enter");
        await until("the login shows", async () =>
          ((await page.locator(".sendSettings").textContent()) ?? "").includes(
            "posts as maintainer-a",
          ),
        );
        expect(await kept(page)).toEqual([
          expect.objectContaining({
            token: GITHUB_TOKEN,
            login: "maintainer-a",
            owners: [],
          }),
        ]);
        expect(opened.calls.at(-1)).toMatchObject({
          method: "GET",
          path: "/user",
        });
        // Every github.com card now has Send beside Copy.
        expect(await page.locator(".copy.send").count()).toBe(3);
        expect(
          await page
            .getByRole("button", { name: "Sending as maintainer-a" })
            .count(),
        ).toBe(1);

        // A reload keeps it; the host never saw it.
        await page.reload();
        await shows(page, ".pNeeds .need");
        await settled(page);
        expect(await page.locator(".copy.send").count()).toBe(3);
        expect(opened.local.length).toBeGreaterThan(0);
        for (const request of opened.local)
          expect(request).not.toContain(GITHUB_TOKEN);

        await page
          .getByRole("button", { name: "Sending as maintainer-a" })
          .click();
        await page.getByRole("button", { name: "Forget the token" }).click();
        await until("Send is gone", async () =>
          page
            .locator(".copy.send")
            .count()
            .then((n) => n === 0),
        );
        expect(await kept(page)).toBeNull();
        expect(
          await page.evaluate((key) => localStorage.getItem(key), EARLIER_KEY),
        ).toBeNull();
        // The browser reports the refused test's 401 itself; nothing else went wrong.
        expect(
          opened.problems.filter((p) => !p.includes("status of 401")),
        ).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "Send posts exactly what Copy copies to the card's pull request, as the person, and the card says it was sent here",
    async () => {
      const opened = await openSend("picks", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      try {
        const two = card(page, "PR #502");
        // Nothing picked yet: Send waits, posts nothing and says why.
        const send = two.getByRole("button", {
          name: "Send the answers for PR #502 as maintainer-a",
        });
        expect(await send.getAttribute("aria-disabled")).toBe("true");
        // A held-back button still says why when pressed.
        await send.click({ force: true });
        await until("Send said why", async () =>
          ((await page.locator(".say").textContent()) ?? "").includes(
            "Not sent: Send needs an option picked on PR #502",
          ),
        );
        expect(opened.calls).toEqual([]);

        await two.locator("[data-card-toggle]").click();
        await two.locator(".opt", { hasText: "Remove" }).click();
        await two.locator(".opt", { hasText: "Later" }).click();
        await page.evaluate((t) => navigator.clipboard.writeText(t), BEFORE);
        await two
          .getByRole("button", { name: "Copy the answers for PR #502" })
          .click();
        await until(
          "Copy copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(TWO);

        await two
          .getByRole("button", {
            name: "Send the answers for PR #502 as maintainer-a",
          })
          .click();
        await two
          .getByRole("button", {
            name: "Confirm and send the answers for PR #502 as maintainer-a",
          })
          .click();
        await until("the card says it was sent", async () =>
          two
            .locator(".sentHere")
            .count()
            .then((n) => n === 1),
        );
        // One comment per decision: Copy's lines for it, then the record jig send writes.
        const sent = posts(opened.calls);
        expect(sent.map((p) => p.path)).toEqual([
          "/repos/example-org/web/issues/502/comments",
          "/repos/example-org/web/issues/502/comments",
        ]);
        expect(sent.map((p) => p.lines).join("\n\n")).toBe(TWO);
        expect(sent.map((p) => p.record)).toEqual([
          expect.objectContaining({
            kind: "drive-answer",
            key: "answer:PRRT_flag",
            writer: { login: "maintainer-a", host: "dashboard (browser)" },
            pr: 502,
            decision: PICK_DIGESTS.flag,
            choice: { option: "Remove", form: "choose" },
          }),
          expect.objectContaining({
            key: "answer:PRRT_table",
            decision: PICK_DIGESTS.table,
            choice: { option: "Later", form: "approve" },
          }),
        ]);
        expect(
          await two
            .locator(".sentHere")
            .getByRole("link")
            .evaluateAll((links) => links.map((a) => a.getAttribute("href"))),
        ).toEqual([
          "https://github.com/example-org/web/pull/502#issuecomment-1",
          "https://github.com/example-org/web/pull/502#issuecomment-2",
        ]);
        expect(await two.locator(".sentHere").textContent()).toContain(
          "Sent here",
        );
        expectTokenOnlyToGithub(opened);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "with nothing picked Send posts no approval while Copy still copies it, and a pick enables Send",
    async () => {
      const opened = await openSend("picks", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      const one = card(page, "PR #501");
      const send = one.getByRole("button", {
        name: "Send the answers for PR #501 as maintainer-a",
      });
      try {
        expect(await send.getAttribute("aria-disabled")).toBe("true");
        expect(await one.locator(".sendWaits").textContent()).toContain(
          "Send posts once you pick an option",
        );
        // Copy keeps its approval of the recommendation with nothing picked.
        await page.evaluate((t) => navigator.clipboard.writeText(t), BEFORE);
        await one
          .getByRole("button", { name: "Copy the approval for PR #501" })
          .click();
        await until(
          "Copy copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(
          `answer PRRT_one: approve [${PICK_DIGESTS.one}]`,
        );
        await send.click({ force: true });
        await until("Send said why", async () =>
          ((await page.locator(".say").textContent()) ?? "").includes(
            "Send needs an option picked on PR #501",
          ),
        );
        expect(opened.calls).toEqual([]);

        await one.locator(".opt", { hasText: "Keep it" }).click();
        await until(
          "the pick enabled Send",
          async () => (await send.getAttribute("aria-disabled")) === "false",
        );
        expect(await one.locator(".sendWaits").count()).toBe(0);
        await send.click();
        await one
          .getByRole("button", {
            name: "Confirm and send the answers for PR #501 as maintainer-a",
          })
          .click();
        await until("the pick was sent", async () => opened.calls.length === 1);
        expect(posts(opened.calls)[0]).toMatchObject({
          lines: `answer PRRT_one: approve [${PICK_DIGESTS.one}]`,
          record: {
            key: "answer:PRRT_one",
            choice: { option: "Keep it", form: "approve" },
          },
        });
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a guarded pick sends only on the second step, which a changed pick ends",
    async () => {
      const opened = await openSend("picks", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      const guarded = card(page, "PR #1300");
      const send = guarded.getByRole("button", {
        name: "Send the answers for PR #1300 as maintainer-a",
      });
      try {
        await showAll(page);
        await guarded.locator("[data-card-toggle]").click();
        await guarded.locator(".opt", { hasText: "Drop" }).last().click();
        await send.click();
        await shows(page, ".pNeeds .guard");
        expect(await guarded.locator(".guard").textContent()).toContain(
          "Send these answers",
        );
        expect(await guarded.locator(".guard").textContent()).toContain(
          "no rollback once deployed",
        );
        expect(opened.calls).toEqual([]);
        // A changed pick ends the step.
        await guarded.locator(".opt", { hasText: "Do not drop" }).click();
        await until(
          "the step ended",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
        await guarded.locator(".opt", { hasText: "Drop" }).last().click();
        await send.click();
        await shows(page, ".pNeeds .guard");
        await guarded
          .getByRole("button", {
            name: "Confirm and send the answers for PR #1300 as maintainer-a",
          })
          .click();
        await until(
          "the second step sent",
          async () => opened.calls.length === 1,
        );
        expect(opened.calls[0]).toMatchObject({
          method: "POST",
          path: "/repos/example-org/api/issues/1300/comments",
        });
        expect(posts(opened.calls)[0]).toMatchObject({
          lines: `answer PRRT_drop: choose Drop [${PICK_DIGESTS.drop}]`,
          record: {
            key: "answer:PRRT_drop",
            choice: { option: "Drop", form: "choose" },
          },
        });
        await until(
          "the panel closed",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "GitHub's refusals are explained, and a login other than the park's person is named",
    async () => {
      const answers: FakeAnswer[] = [
        { status: 404, json: { message: "Not Found" } },
        {
          status: 403,
          json: { message: "Resource not accessible by personal access token" },
        },
        { status: 422, json: { message: "Validation Failed" } },
      ];
      const opened = await openSend("picks", {
        kept: { login: "someone-else" },
        github: () => answers.shift() ?? { status: 500, json: {} },
      });
      const { page } = opened;
      const one = card(page, "PR #501");
      const send = one.getByRole("button", {
        name: "Send the answers for PR #501 as someone-else",
      });
      try {
        expect(await one.locator(".sendSaid").textContent()).toContain(
          "Sends as someone-else; this waits on maintainer-a",
        );
        await one.locator(".opt", { hasText: "Keep it" }).click();
        for (const said of [
          "404: Not Found",
          "403: Resource not accessible by personal access token",
          "422: Validation Failed",
        ]) {
          await send.click();
          await one
            .getByRole("button", {
              name: "Confirm and send the answers for PR #501 as someone-else",
            })
            .click();
          await until(`the card says ${said}`, async () =>
            ((await one.locator(".sendSaid").textContent()) ?? "").includes(
              said,
            ),
          );
          expect(await one.locator(".sendSaid").textContent()).toContain(
            "nothing was posted",
          );
        }
        expect(await one.locator(".sentHere").count()).toBe(0);
        expect(opened.calls).toHaveLength(3);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a card no drive reads an answer comment for, or not on github.com, says why it has no Send",
    async () => {
      const opened = await openSend("loud", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      try {
        await showAll(page);
        expect(await page.locator(".copy.send").count()).toBe(0);
        const why = await page.locator(".noSend").allTextContents();
        expect(
          why.some((t) =>
            t.includes("this station cannot read an answer comment"),
          ),
        ).toBe(true);
        expect(
          why.some((t) =>
            t.includes(
              "Send posts to github.com only, and this pull request is at forge.example",
            ),
          ),
        ).toBe(true);
        expect(opened.calls).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  for (const viewport of [PHONE, NARROW])
    browserIt(
      `at ${viewport.width} px, by touch alone, a token is kept and a card sends, with no side scroll and 44 px targets`,
      async () => {
        const opened = await openSend("picks", { viewport, touch: true });
        const { page } = opened;
        try {
          await page.getByRole("button", { name: "Send from here" }).tap();
          await shows(page, ".sendSettings");
          await page.getByLabel("GitHub token").tap();
          await page.keyboard.type(GITHUB_TOKEN);
          await page.getByRole("button", { name: "Test and keep" }).tap();
          await until("the login shows", async () =>
            (
              (await page.locator(".sendSettings").textContent()) ?? ""
            ).includes("posts as maintainer-a"),
          );
          await noSideScroll(page);
          expect(await shortControls(page)).toEqual([]);
          await page.getByRole("button", { name: "Close" }).tap();

          const two = card(page, "PR #502");
          await two.locator("[data-card-toggle]").tap();
          await two.locator(".opt", { hasText: "Remove" }).tap();
          await two.locator(".opt", { hasText: "Later" }).tap();
          await two
            .getByRole("button", {
              name: "Send the answers for PR #502 as maintainer-a",
            })
            .tap();
          await two
            .getByRole("button", {
              name: "Confirm and send the answers for PR #502 as maintainer-a",
            })
            .tap();
          await until("the card says it was sent", async () =>
            two
              .locator(".sentHere")
              .count()
              .then((n) => n === 1),
          );
          expect(opened.calls.at(-1)).toMatchObject({
            method: "POST",
            path: "/repos/example-org/web/issues/502/comments",
          });
          expect(
            posts(opened.calls)
              .map((p) => p.lines)
              .join("\n\n"),
          ).toBe(TWO);
          await noSideScroll(page);
          expect(await shortControls(page)).toEqual([]);
          expectTokenOnlyToGithub(opened);
          expect(opened.problems).toEqual([]);
        } finally {
          await opened.context.close();
        }
      },
      TIMEOUT,
    );
});

function stationNeeds(issueRepository?: string): LineNeed[] {
  const base = fixture("picks").line?.needs[0];
  assert(base);
  const facts: StationFacts[] = [
    { kind: "stalled", item: "#17", state: "In Progress", carriedBy: [] },
    { kind: "followup-stale", pr: 18, marker: 4, released: null },
    { kind: "drive", pr: 19, exit: "1", started: null, failedRearm: null },
  ];
  return facts.map((fact, i) => {
    const { key, decision } = frameStationDecision(fact);
    const pr = i === 0 ? null : 17 + i;
    return {
      ...base,
      target: pr === null ? "#17" : `PR #${pr}`,
      pr,
      stage: i === 0 ? "pickup" : i === 1 ? "followup" : "drive",
      cause: i === 0 ? "stalled" : i === 1 ? "followup-stale" : "needs-person",
      url: `https://github.com/${pr === null ? (issueRepository ?? base.repo) : base.repo}/${pr === null ? "issues/17" : `pull/${pr}`}`,
      decisions: [
        {
          ...decisionOf({
            key,
            kind: "finding",
            decision,
            digest: dispatcherDecisionDigest({ key, decision }),
            lines: [],
          }),
          answer: {
            station: i === 0 ? "pickup" : i === 1 ? "followup" : "drive",
            address: `${i === 0 ? "pickup" : i === 1 ? "followup" : "drive"}@${base.repo}#${17 + i}`,
            on: pr === null ? "issue" : "pull-request",
            framedBy: "dispatcher",
            ...(pr === null
              ? { repository: issueRepository ?? base.repo }
              : {}),
          },
        },
      ],
    } as LineNeed;
  });
}

browserIt(
  "pickup, follow-up and drive recovery each Send a comment the station parses after confirmation",
  async () => {
    const needs = stationNeeds("example-org/tasks");
    const opened = await openSend("picks", {
      kept: { login: "maintainer-a" },
      needs,
    });
    try {
      const { page } = opened;
      await showAll(page);
      for (const [i, need] of needs.entries()) {
        const decision = need.decisions[0];
        assert(decision);
        const item = card(page, need.target);
        expect(await item.locator(".copy.send").count()).toBe(1);
        await item.locator(".opt").first().click();
        await item
          .getByRole("button", {
            name: `Send the answers for ${need.target} as maintainer-a`,
          })
          .click();
        expect(posts(opened.calls)).toHaveLength(i);
        expect(await item.locator(".guard").textContent()).toContain(
          `${decision.answer?.repository ?? need.repo} #${17 + i}`,
        );
        expect(await item.locator(".sendPreview").textContent()).toContain(
          `answer ${decision.key}:`,
        );
        await item
          .getByRole("button", {
            name: `Confirm and send the answers for ${need.target} as maintainer-a`,
          })
          .click();
        await until(
          "the station answer posted",
          async () => posts(opened.calls).length === i + 1,
        );
        const posted = posts(opened.calls)[i];
        assert(posted);
        const call = opened.calls.filter((c) => c.method === "POST")[i];
        assert(call);
        const destination = decision.answer?.repository ?? need.repo;
        expect(posted.path).toBe(
          `/repos/${destination}/issues/${17 + i}/comments`,
        );
        const parsed = parseAnswerComment(
          stationItem(decision),
          {
            body: (
              call.body as {
                body: string;
              }
            ).body,
            author: "maintainer-a",
            association: "MEMBER",
            url: `https://github.com/${need.repo}/issues/${17 + i}#issuecomment-7`,
            at: "2026-11-15T21:00:00Z",
          },
          "conversation",
        );
        expect(parsed?.choice?.option).toBe(
          decision.options?.find((o) => o.recommended)?.name,
        );
      }
      expectTokenOnlyToGithub(opened);
    } finally {
      await opened.context.close();
    }
  },
  TIMEOUT,
);

browserIt(
  "a changed note needs a fresh confirmation, and a posted answer polls until its tick outcome",
  async () => {
    const needs = stationNeeds().slice(0, 1);
    const need = needs[0];
    assert(need);
    const decision = need.decisions[0];
    assert(decision);
    const opened = await openSend("picks", {
      kept: { login: "maintainer-a" },
      needs,
    });
    try {
      const { page } = opened;
      await page.clock.install();
      const item = card(page, need.target);
      const send = item.getByRole("button", {
        name: `Send the answers for ${need.target} as maintainer-a`,
      });
      await item.locator(".opt").first().click();
      await send.click();
      await item.locator("[data-card-toggle][aria-expanded=false]").click();
      await item.getByRole("button", { name: "Add a note" }).click();
      await item.locator(".reply input").fill("Only after checking the branch");
      expect(await item.locator(".guard").count()).toBe(0);
      expect(posts(opened.calls)).toHaveLength(0);
      await send.click();
      expect(await item.locator(".sendPreview").textContent()).toContain(
        "Only after checking the branch",
      );
      await item
        .getByRole("button", {
          name: `Confirm and send the answers for ${need.target} as maintainer-a`,
        })
        .click();
      await until(
        "posted receipt",
        async () => (await item.locator(".sentHere a").count()) === 1,
      );
      const url = await item.locator(".sentHere a").getAttribute("href");
      decision.acted = {
        option: "Release the claim",
        author: "maintainer-a",
        outcome: "done",
        detail: "Released the claim",
        answer: `${url} 2026-11-15T21:00:00Z`,
      };
      const stateReads = () =>
        opened.local.filter((s) => s.includes("/state?")).length;
      const before = stateReads();
      await page.clock.runFor(3_000);
      await until(
        "quicker state read reports the tick outcome",
        async () =>
          stateReads() > before &&
          ((await item.locator(".actedAnswer").textContent()) ?? "").includes(
            "carried out",
          ),
      );
      const after = stateReads();
      await page.clock.runFor(6_000);
      expect(stateReads()).toBe(after);
    } finally {
      await opened.context.close();
    }
  },
  TIMEOUT,
);

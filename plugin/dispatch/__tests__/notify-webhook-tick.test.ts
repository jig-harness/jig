/**
 * dispatch --apply through a whole tick on `runtime: process`: the machine
 * file's `notify.channels` reaches the `notify` stage through the act
 * phase's own wiring (`tick-apply.ts`), and a parked drive's cause is posted
 * to the webhook whose address the tick's environment holds, with no Orca
 * card written. The tick runs in a child with its own home (fixtures.ts).
 */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/schema.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, machineFile } from "./launch-fixtures.ts";
import { notifyWrites, withOrigin } from "./pickup-fixtures.ts";

const SECRET = "hooks/s3cr3t-topic";

const PARK: ParkedItem = {
  key: "F1",
  kind: "finding",
  reason: "Which retry budget should the client keep?",
  round: 2,
  at: "2026-10-30T21:00:00.000Z",
  class: "design-choice",
  record:
    "Question: which retry budget should the client keep?\nOptions: (a) three retries; (b) five retries\nRecommended: (a), the budget the timeout was sized for",
};

const LATER_PARK: ParkedItem = {
  ...PARK,
  key: "F2",
  reason: "Which timeout should the client keep?",
  record:
    "Question: which timeout should the client keep?\nOptions: (a) ten seconds; (b) thirty seconds\nRecommended: (a), the budget the retries were sized for",
};

let current: World | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  current?.close();
  current = null;
  for (const server of servers.splice(0)) server.stop(true);
});

it.skipIf(process.platform === "win32")(
  "starts a new webhook from the notice already standing, then posts a later one once, and writes no card",
  async () => {
    const posts: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        posts.push(await request.text());
        return new Response("ok");
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/${SECRET}`;

    const w = world();
    current = w;
    w.setConfig(
      `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
    );
    withOrigin(w);
    w.setPrs("open", [openPr(7, "feature/7-parked")]);
    w.setComments(7, [
      ledgerComment(701, stoppedLedger(7, 8, { parked: [PARK] })),
    ]);
    mkdirSync(join(w.root, "ws-7"), { recursive: true });
    machineFile(
      w,
      [account(w, "a", "a@example.com")],
      {
        runtime: "process",
        notify: {
          channels: [
            {
              name: "phone",
              kind: "webhook",
              url_env: "JIG_TEST_PHONE_URL",
            },
          ],
        },
      },
      ["rearm", "notify"],
    );
    const tick = async (): Promise<TickReceipt> => {
      const r = await w.dispatch(["--apply", "--json"], undefined, {
        JIG_TEST_PHONE_URL: url,
      });
      expectSpawnExit(r, 0);
      expect(r.stdout).not.toContain(SECRET);
      return JSON.parse(r.stdout) as TickReceipt;
    };

    const first = await tick();
    const started = first.repos[0];
    expect(started?.channelStarts).toEqual([{ channel: "phone", causes: 1 }]);
    expect(
      (started?.notifications ?? []).map((n) => [n.channel, n.outcome]),
    ).toEqual([["phone", "suppressed"]]);
    expect(posts).toEqual([]);
    expect(notifyWrites(w)).toEqual([]);

    w.setComments(7, [
      ledgerComment(702, stoppedLedger(7, 8, { parked: [LATER_PARK] })),
    ]);
    const second = await tick();
    const notified = second.repos[0]?.notifications ?? [];
    expect(notified.map((n) => [n.channel, n.cause, n.outcome])).toEqual([
      ["phone", "parked", "sent"],
    ]);
    expect(second.repos[0]?.channelStarts).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`${SLUG} PR #7 parked`);
    expect(second.repos[0]?.noticesWorkspace).toBeUndefined();
    expect(notifyWrites(w)).toEqual([]);

    const third = await tick();
    expect(
      (third.repos[0]?.notifications ?? []).map((n) => [n.channel, n.outcome]),
    ).toEqual([["phone", "suppressed"]]);
    expect(posts).toHaveLength(1);
  },
  120_000,
);

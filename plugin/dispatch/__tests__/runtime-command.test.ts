/**
 * dispatch: which Orca command a tick reads its sessions through when no
 * Orca terminal started it, as a wake-up from Orca's plugin worker or a
 * scheduler's run does. On Linux a bare `orca` on `PATH` is often GNOME's
 * screen reader, which fails without a display; the tick reads Orca
 * through `orca-ide`, the name Orca installs its command under there.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import type { TickReceipt } from "../receipts.ts";
import { openPr, SLUG, type World, world } from "./fixtures.ts";

/** A program named `orca` that is not Orca: it says so on stderr and exits 1, leaving a mark. */
const SCREEN_READER = `#!/usr/bin/env bun
require("node:fs").writeFileSync(process.env.DISPATCH_FAKE_DIR + "/screen-reader-ran", "");
console.error("(orca:1): dbind-CRITICAL **: atspi_device_x11_init: assertion 'priv->display != NULL' failed");
process.exit(1);
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

describe("the Orca command a tick outside an Orca terminal runs", () => {
  it.if(process.platform === "linux")(
    "is orca-ide on Linux, never the screen reader named orca",
    async () => {
      const w = world();
      current = w;
      w.setConfig(`dispatch:\n  states: [todo]\n`);
      w.setPrs("open", [openPr(7, "feature/7-open")]);
      writeFakeProgram(join(w.root, "bin", "orca"), SCREEN_READER);
      const r = await w.dispatch(["--repo", w.repo, "--json"]);
      expectSpawnExit(r, 0);
      const receipt = JSON.parse(r.stdout) as TickReceipt;
      const runtime = receipt.repos[0]?.records.find(
        (record) => record.record === "runtime",
      );
      expect(runtime).toMatchObject({ ok: true });
      expect(existsSync(join(w.dir, "screen-reader-ran"))).toBe(false);
      expect(readFileSync(join(w.dir, "orca-calls.log"), "utf8")).toContain(
        '["repo","list","--json"]',
      );
      expect(receipt.repos[0]?.slug).toBe(SLUG);
    },
  );
});

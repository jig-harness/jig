import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import type { Tracker } from "../../../do-item/scripts/lib/tracker/port.ts";
import { fakeForge } from "../deferred-forge.ts";
import { persistedTracker } from "../persisted-tracker.ts";
import * as adapters from "../../../do-item/scripts/lib/tracker/index.ts";
import * as prBody from "../../scripts/lib/pr-body.ts";

const capture = process.env.JIG_TEST_DEFERRAL_CAPTURE;
if (capture === undefined) throw new Error("missing capture path");
const forge = fakeForge("");
const tracker = persistedTracker({
  searchIssues: async () => [],
  async createIssue(issue) {
    await Bun.write(capture, issue.description);
    return { identifier: "#43", url: "https://github.com/example/project/issues/43" };
  },
} as Tracker);
const bodyWrite = forge.write;
const bodyRead = forge.read;
forge.read = async () => {
  appendFileSync(`${capture}.calls`, "read\n");
  return bodyRead();
};
forge.write = async (pr, body) => {
  appendFileSync(`${capture}.calls`, "write\n");
  await bodyWrite(pr, body);
  await Bun.write(capture, body);
};
mock.module("../../../do-item/scripts/lib/tracker/index.ts", () => ({
  ...adapters,
  openTracker: () => tracker,
}));
mock.module("../../scripts/lib/pr-body.ts", () => ({
  ...prBody,
  ghPrBodyForge: () => forge,
}));

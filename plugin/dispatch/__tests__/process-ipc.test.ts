import { afterEach, expect, it } from "bun:test";
import {
  offerProcessRequest,
  readProcessRequest,
} from "../lib/runtime/process-ipc.ts";
import { type World, world } from "./fixtures.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";

let fixture: World | undefined;
afterEach(() => fixture?.close());

it("hands the environment only to the bootstrap with the launch's token", async () => {
  const w = world();
  fixture = w;
  const record = earlierRecord(w, {
    id: "20261030T200000Z-01234567",
    account: "example",
    runtime: "process",
  });
  const other = earlierRecord(w, {
    id: "20261030T200001Z-01234567",
    account: "example",
    runtime: "process",
    token: "a-different-launch-token",
  });
  const request = {
    id: record.id,
    token: record.token,
    workspace: w.repo,
    env: { GH_TOKEN: "fixture-auth-value", USER: "example" },
  };
  const offered = await offerProcessRequest(request, 5_000);
  if (!offered.ok) throw new Error(offered.failure.reason);
  const { address, accepted, close } = offered.value;
  try {
    const wrong = await readProcessRequest(address, other.id, dispatchState(w));
    expect(wrong.ok).toBe(false);
    const received = await readProcessRequest(
      address,
      record.id,
      dispatchState(w),
    );
    expect(received).toEqual({ ok: true, value: request });
    expect(await accepted).toBe(true);
    const second = await readProcessRequest(
      address,
      record.id,
      dispatchState(w),
    );
    expect(second.ok).toBe(false);
  } finally {
    close();
  }
});

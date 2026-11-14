import { expect, it } from "bun:test";
import { FakeLinear } from "./served-linear-fake.ts";

it("reads only the registered union of native queue states, including requested closed factory states", async () => {
  const fake = new FakeLinear();
  fake.add({ identifier: "ENG-1", assignee: "alex" });
  fake.add({
    identifier: "ENG-2",
    assignee: "alex",
    state: { name: "Another Queue", type: "unstarted" },
  });
  fake.add({
    identifier: "ENG-3",
    assignee: "alex",
    state: { name: "Done", type: "completed" },
  });
  const source = fake.tracker().dispatchSource;
  if (source === undefined) throw new Error("missing native source");
  expect((await source.queue("alex")).map((row) => row.identifier)).toEqual([
    "ENG-1",
  ]);
  source.configure?.([
    ...(source.requirements ?? []),
    "queue-state:Another Queue",
  ]);
  expect((await source.queue("alex")).map((row) => row.identifier)).toEqual([
    "ENG-1",
    "ENG-2",
  ]);
  source.configure?.([...(source.requirements ?? []), "queue-state:Done"]);
  expect((await source.queue("alex")).map((row) => row.identifier)).toEqual([
    "ENG-1",
    "ENG-2",
    "ENG-3",
  ]);
});

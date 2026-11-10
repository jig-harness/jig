import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { optionDetails, type Call, type Option } from "../decisions/model.ts";
import { Checker } from "../decisions/source.ts";

test("optional option fields become labelled details without inventing absent values", () => {
  const option: Option = {
    id: "a",
    name: "Keep",
    summary: "Keep the current system",
    pay: [],
  };
  const call: Call = { id: "a", options: [option] };
  expect(call.options.map(optionDetails)).toEqual([[]]);
  expect(
    optionDetails({
      ...option,
      tag: "steady",
      keep: ["One", "Two"],
      rightWhen: "Capacity is enough",
      obligation: "Check capacity",
    }),
  ).toEqual([
    { label: "Tag", text: "steady" },
    { label: "Keep", text: "One\nTwo" },
    { label: "Right when", text: "Capacity is enough" },
    { label: "Obligation", text: "Check capacity" },
  ]);
});

test("portable checker collects strict shape, identifier and claim errors", () => {
  const c = new Checker();
  c.object({ extra: true }, "$", ["name"], []);
  c.uniqueIds([{ id: "a" }, { id: "a" }, { id: "too-long-id" }], "$.options");
  c.claims([{ text: "Fact", source: "" }], "$.facts", 1);
  expect(c.problems).toEqual([
    "$.extra: unknown field",
    "$.name: is required",
    "$.options[2].id: must be 1-8 letters or digits",
    "$.options: has a duplicate id",
    "$.facts[0].source: must be a non-empty string",
  ]);
});

test("the shared decision model and checker bundle for a browser", async () => {
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("../decisions/model.ts", import.meta.url)),
      fileURLToPath(new URL("../decisions/source.ts", import.meta.url)),
    ],
    target: "browser",
  });
  expect(built.success).toBe(true);
  expect(built.logs).toEqual([]);
});

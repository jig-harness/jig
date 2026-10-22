import { expect, test } from "bun:test";
import { chooseBranch } from "./launch.ts";

test("the branch is the one the launch named, else the tracker's suggestion", () => {
  expect(chooseBranch("me/named", { branch_name: "eng-1-x" })).toBe("me/named");
  expect(chooseBranch("", { branch_name: "eng-1-x" })).toBe("eng-1-x");
  expect(chooseBranch("", { branch_name: "" })).toBe("");
  expect(chooseBranch("", null)).toBe("");
});

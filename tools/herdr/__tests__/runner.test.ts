import { expect, test } from "bun:test";
import { localRunner } from "../runner.ts";

test("commands run with untranslated messages", () => {
  const ran = localRunner([
    "/bin/sh",
    "-c",
    'printf "%s|%s" "$LC_ALL" "$LANGUAGE"',
  ]);
  expect(ran.status).toBe(0);
  expect(ran.stdout).toBe("C|");
});

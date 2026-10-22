import {
  byPlatform,
  skipsOnWindows,
} from "../../../../lib/test-helpers/windows-skip.ts";

export const skipLargeCensus = skipsOnWindows(
  "fixture-throughput",
  "the real 50,010-entry fixture exceeds 60 seconds on native Windows",
);

export function compactsDirectoryFences(): boolean {
  return (
    byPlatform(
      "Windows preserves nonempty directory fences to block delayed directory replacement",
      {
        windows: "no",
        posix: "yes",
      },
    ) === "yes"
  );
}

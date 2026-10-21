/**
 * An `OpenRequest` for a provider's tests: issue ENG-1, never aborted, whose
 * `promptFor` adds a cache-file line to `head`.
 */
import type { OpenRequest } from "./provider.ts";

export function openRequest(
  repo: unknown,
  head: string,
  options: { branch?: string; cacheFile?: string } = {},
): OpenRequest {
  const cacheFile =
    options.cacheFile ?? "/home/me/.cache/conductor-linear/ENG-1.json";
  const promptFor = (file: string): string =>
    `${head}\nLauncher context: ${file}`;
  return {
    issue: "ENG-1",
    prompt: options.cacheFile === undefined ? head : promptFor(cacheFile),
    cacheFile,
    promptFor,
    branch: options.branch ?? "",
    repo,
    signal: new AbortController().signal,
  };
}

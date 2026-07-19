import { logger } from "./log";
export async function load(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  logger.info("loaded", res.status);
  return res;
}

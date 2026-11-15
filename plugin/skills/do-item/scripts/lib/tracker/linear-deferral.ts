/** The deferral workflow's client uses the Linear adapter's governed transport. */
import { defaultTransport, type LinearTransport } from "./linear-transport.ts";
import { record } from "./linear-shapes.ts";

/** Required run deadline, shared by every read and write of the workflow. */
export type LinearClient = (
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

export function deferralClient(
  transport: LinearTransport = defaultTransport(),
): LinearClient {
  return async (query, variables, signal) =>
    record(await transport(query, variables, signal), "deferral response");
}

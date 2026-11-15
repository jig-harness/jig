/** The deferral workflow's client uses the Linear adapter's governed transport. */
import { defaultTransport, type LinearTransport } from "./linear-transport.ts";
import { record } from "./linear-shapes.ts";

/**
 * The deferral command historically preferred its dedicated token when both
 * credential names were set. Keep that selection while delegating requests to
 * the adapter's governed transport.
 */
export function deferralEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const token = env.LINEAR_API_TOKEN?.trim();
  return token === undefined || token === ""
    ? env
    : { ...env, LINEAR_API_KEY: token };
}

/** Required run deadline, shared by every read and write of the workflow. */
export type LinearClient = (
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

export function deferralClient(
  transport: LinearTransport = defaultTransport(deferralEnvironment()),
): LinearClient {
  return async (query, variables, signal) =>
    record(await transport(query, variables, signal), "deferral response");
}

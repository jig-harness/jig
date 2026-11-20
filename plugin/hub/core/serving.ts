/**
 * The serving port: a request in, a response out, with the caller's
 * credential or the webhook's signature headers
 * ([design/control-plane.md § The portable core and its adapters](../../../design/control-plane.md#the-portable-core-and-its-adapters)).
 *
 * The adapter owns the listener (Bun's HTTP server, a Worker's `fetch`
 * handler). It turns each request into a `HubRequest`, runs the core's
 * `RequestHandler` for it as one unit (`runUnit`), and writes the
 * `HubResponse` back. The body stays bytes, so a webhook's signature is
 * checked over exactly what was sent.
 */
import type { Outcome } from "../../shared/outcome.ts";
import type { UnitContext } from "./unit.ts";

/** How serving fails: the listener could not start or stopped (`unavailable`), or the unit's signal stopped it (`aborted`). */
export type ServingFailureCode = "unavailable" | "aborted";

/** A request as the core reads it, whichever platform received it. */
export interface HubRequest {
  readonly method: string;
  /** The path, without the query (`/webhooks/github`). */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** The caller's bearer credential, or null when it sent none. */
  readonly credential: string | null;
  /**
   * The headers a webhook's sender signs or names its delivery by, lower
   * case; empty for a request that is no webhook.
   */
  readonly signatureHeaders: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** When the adapter received it, epoch milliseconds. */
  readonly receivedAt: number;
}

/** A response as the core writes it. */
export interface HubResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The core's side of serving: one request, one response. A failure the
 * core handles is still a response (a coded error body); a failed outcome
 * is one the adapter answers with a generic server error.
 */
export type RequestHandler = (
  context: UnitContext,
  request: HubRequest,
) => Promise<Outcome<HubResponse>>;

export interface ServingPort {
  /**
   * Hands `handler` every request from now on. A process adapter resolves
   * when its listener stops; a platform that owns the listener resolves
   * once the handler is in place.
   */
  serve(
    context: UnitContext,
    handler: RequestHandler,
  ): Promise<Outcome<void, ServingFailureCode>>;
}

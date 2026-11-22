/**
 * The outbound port: a call to the forge or the tracker through its
 * governed transport, over `fetch`
 * ([ADR-0021](../../../docs/adr/ADR-0021-outbound-calls-are-governed.md),
 * [design/outbound-calls.md](../../../design/outbound-calls.md)).
 *
 * The transport behind the port keeps the outbound library's obligations:
 * it reuses an answer it holds (a conditional request whose "not modified"
 * costs nothing), asks the shared budget before it sends, bounds the
 * call's cost, records it in the cost ledger under the operation and the
 * repository, and fails as one of the closed failure classes
 * (`shared/outbound/failure.ts`), which a caller branches on alone.
 */
import type { OutboundFailure } from "../../shared/outbound/failure.ts";
import type { UnitContext } from "./unit.ts";

/** The outside systems the hub calls. */
export type OutboundSystem = "github" | "linear" | "jira";

/** One call, as the core asks for it; the transport adds the credential. */
export interface OutboundRequest {
  readonly system: OutboundSystem;
  /** The named operation the cost ledger counts the call under. */
  readonly operation: string;
  /** The repository the call is for, `owner/name`; null for none. */
  readonly repository: string | null;
  /** Only a read is sent again or answered from what the transport holds. */
  readonly read: boolean;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** The path under the system's API root (`/repos/o/r/pulls`, `/graphql`). */
  readonly path: string;
  /** The JSON body, for a write or a GraphQL query. */
  readonly body?: unknown;
}

/** A call's answer. */
export interface OutboundAnswer {
  readonly status: number;
  /** The parsed JSON body; for a "not modified" answer, the one held. */
  readonly body: unknown;
  /** Whether the system answered "not modified", which costs nothing. */
  readonly notModified: boolean;
}

/** A call's outcome: its answer, or a failure of one of the closed classes. */
export type OutboundOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: OutboundFailure };

export interface OutboundPort {
  /**
   * Sends `request` through the system's governed transport, within the
   * unit's deadline; the unit's signal aborting fails it `unreachable`.
   */
  call(
    context: UnitContext,
    request: OutboundRequest,
  ): Promise<OutboundOutcome<OutboundAnswer>>;
}

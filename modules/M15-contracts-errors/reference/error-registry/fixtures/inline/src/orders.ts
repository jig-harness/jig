// Two codes constructed outside the registry: one with a literal, one computed.
import { ErrorCode } from "../../registry/error-code";
import { ErrorCodes } from "../../registry/registry";

export function fail(kind: string) {
  if (kind === "order")
    throw new DomainError(new ErrorCode("ORD-001", { status: 404, severity: "warning" }));
  const code = `ORD-${kind}`;
  throw new DomainError(new ErrorCode(code, { status: 500, severity: "fatal" }));
}

export const known = [ErrorCodes.INTERNAL, ErrorCodes.VALIDATION, ErrorCodes.NOT_FOUND, ErrorCodes.CONFLICT];

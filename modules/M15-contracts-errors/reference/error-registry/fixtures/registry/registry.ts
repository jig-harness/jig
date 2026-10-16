// The registry: the only place a code is constructed.
import { ErrorCode } from "./error-code";

export const ErrorCodes = {
  INTERNAL: new ErrorCode("SYS-001", { status: 500, severity: "fatal" }),
  VALIDATION: new ErrorCode("VAL-001", { status: 400, severity: "warning" }),
  NOT_FOUND: new ErrorCode("RES-001", { status: 404, severity: "warning" }),
  CONFLICT: new ErrorCode("RES-002", { status: 409, severity: "warning" }),
};

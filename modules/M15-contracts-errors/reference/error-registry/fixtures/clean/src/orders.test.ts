// A test may construct a code of its own; tests are not scanned.
import { ErrorCode } from "../../registry/error-code";

export const fake = new ErrorCode("TST-001", { status: 500, severity: "fatal" });

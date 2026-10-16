// Every registered code is referenced, by name or by literal, and no code
// is constructed here: only the registry calls the code's constructor.
import { ErrorCodes } from "../../registry/registry";
import { ErrorCodeView } from "./view";

const HINT = "construct a code only in the registry";

export function load(id: string) {
  if (id === "") throw new DomainError(ErrorCodes.VALIDATION);
  if (id === "missing") throw new DomainError(ErrorCodes.NOT_FOUND);
  if (id === "taken") throw new DomainError(ErrorCodes.CONFLICT);
  return new ErrorCodeView(id, HINT);
}

export const BY_LITERAL: Record<string, string> = { "SYS-001": "internal" };

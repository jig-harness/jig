// One registered code is never referenced here: an orphan.
import { ErrorCodes } from "../../registry/registry";

export function load(id: string) {
  if (id === "") throw new DomainError(ErrorCodes.VALIDATION);
  if (id === "missing") throw new DomainError(ErrorCodes.NOT_FOUND);
  return id;
}

export const BY_LITERAL: Record<string, string> = { "SYS-001": "internal" };

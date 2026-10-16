export class ErrorCode {
  constructor(
    readonly code: string,
    readonly meta: { status: number; severity: string },
  ) {}
}

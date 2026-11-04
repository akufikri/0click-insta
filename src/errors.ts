export type ErrorCode =
  | "DeviceNotRunning"
  | "NotLoggedIn"
  | "RateLimited"
  | "SelectorMissing"
  | "BadCredentials"
  | "BadTarget"
  | "Unsupported"
  | "TbTimeout"
  | "TbNonJson"
  | "TbFailed"
  | "ConfirmRequired"
  | "InvalidDeviceId"
  | "DeviceExists"
  | "ChallengeRequired"
  | "CaptchaUnsolvable"
  | "ProxyInvalid"
  | "PaneNotStarted";

export class IgError extends Error {
  code: ErrorCode;
  details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new IgError(code, message, details);
}

export function asIgError(error: unknown): IgError {
  if (error instanceof IgError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new IgError("TbFailed", message);
}

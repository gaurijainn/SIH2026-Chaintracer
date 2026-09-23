/** Typed error for every failed API call. `message` is investigator-safe; raw server text is never surfaced. */
export class ApiError extends Error {
  readonly status: number;
  /** Machine code from the API body (`{ error: 'INVALID_BODY' }`), or NETWORK / TIMEOUT / UNKNOWN. */
  readonly code: string;
  readonly issues: { path: string; message: string }[];

  constructor(status: number, code: string, message: string, issues: { path: string; message: string }[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isNetwork() {
    return this.status === 0;
  }
  get isServer() {
    return this.status >= 500;
  }
}

const FALLBACK: Record<number, string> = {
  400: 'The request was not accepted. Check the values entered and try again.',
  401: 'Your session has ended. Please sign in again.',
  403: 'Your role does not permit this action.',
  404: 'The requested record could not be found.',
  409: 'This record was changed by someone else. Reload and try again.',
  413: 'The submitted data is too large.',
  429: 'Too many requests. Wait a moment and try again.',
};

const BY_CODE: Record<string, string> = {
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  TOKEN_MISSING: FALLBACK[401]!,
  TOKEN_EXPIRED: FALLBACK[401]!,
  TOKEN_INVALID: FALLBACK[401]!,
  REFRESH_REVOKED: FALLBACK[401]!,
  FORBIDDEN: FALLBACK[403]!,
};

/** Maps a status + body to a message an investigator can act on. Server text is never shown verbatim. */
export function humanMessage(status: number, body?: { error?: unknown }): string {
  if (status === 0) return 'Cannot reach the server. Check your connection and try again.';
  if (status >= 500) return 'The server hit a problem processing this request. Try again shortly; if it persists, contact your administrator.';
  const byCode = typeof body?.error === 'string' ? BY_CODE[body.error] : undefined;
  return byCode ?? FALLBACK[status] ?? 'The request could not be completed.';
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(0, 'UNKNOWN', 'Something unexpected went wrong.');
}

/** Message for toasts / ErrorState from anything thrown. */
export const errorMessage = (err: unknown) => toApiError(err).message;

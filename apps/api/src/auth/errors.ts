export type AuthErrorCode = 'TOKEN_MISSING' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'INVALID_CREDENTIALS' | 'REFRESH_REVOKED' | 'FORBIDDEN';

/** Thrown by the auth layer; `httpErrorHandler` maps it to 401/403 with a stable machine-readable code. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status: 401 | 403 = code === 'FORBIDDEN' ? 403 : 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class PiiDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiiDecryptionError';
  }
}

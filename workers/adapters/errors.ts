/** An HTTP-level failure from a provider (or a provider that reports a failure inside a 200 body). */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public provider: string,
    public status?: number,
    public retryAfterMs?: number,
    /** force retry / no-retry regardless of status */
    public retryable?: boolean,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/**
 * Every provider (primary and backups) failed, is rate-limited out, has an open circuit or ran out of
 * quota. This is what callers see instead of a raw 429.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    public causes: { provider: string; error: unknown }[],
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

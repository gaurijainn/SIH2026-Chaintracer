/**
 * B7.6 typed errors for the risk-scoring pipeline. Each maps to exactly one HTTP status in
 * `riskErrorHandler` (routes.ts) so a failed dependency is never mistaken for a genuine score.
 */

/** The ML service did not respond within the configured timeout. */
export class MlTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlTimeoutError';
  }
}

/** The ML service could not be reached at all (connection refused/DNS/etc). */
export class MlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlUnavailableError';
  }
}

/** The ML service replied with a non-2xx HTTP status. */
export class MlHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MlHttpError';
  }
}

/** The ML service replied 2xx but the body did not match the expected response shape. */
export class MlResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlResponseError';
  }
}

/** `traceId` was supplied but no such TraceJob exists. */
export class TraceNotFoundError extends Error {
  constructor(traceId: string) {
    super(`no TraceJob found for traceId=${traceId}`);
    this.name = 'TraceNotFoundError';
  }
}

/** The requested chain is not supported by the (TRON-only, v1) ML model. */
export class UnsupportedChainError extends Error {
  constructor(chain: string) {
    super(`risk scoring is only available for chain=TRON (v1 model); got ${chain}`);
    this.name = 'UnsupportedChainError';
  }
}

/** Persisting the computed RiskScore row failed. */
export class RiskPersistError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RiskPersistError';
  }
}

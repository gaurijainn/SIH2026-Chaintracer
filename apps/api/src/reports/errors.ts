export class CaseNotFoundError extends Error {
  constructor(id: string) {
    super(`case not found: ${id}`);
  }
}

export class ReportGenerationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/** Thrown by ReportService.verify when no Report row matches the given sha256. */
export class EvidenceNotFoundError extends Error {
  constructor(sha256: string) {
    super(`no evidence report found for hash: ${sha256}`);
  }
}

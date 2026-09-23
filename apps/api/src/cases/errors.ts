export class CaseNotFoundError extends Error {
  constructor(id: string) {
    super(`case not found: ${id}`);
  }
}

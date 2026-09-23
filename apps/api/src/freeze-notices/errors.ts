export class FreezeNoticeNotFoundError extends Error {
  constructor(id: string) {
    super(`freeze notice not found: ${id}`);
  }
}

export class CaseNotFoundError extends Error {
  constructor(id: string) {
    super(`case not found: ${id}`);
  }
}

export class VaspNotFoundError extends Error {
  constructor(id: string) {
    super(`VASP not found: ${id}`);
  }
}

export class AlertNotFoundError extends Error {
  constructor(id: string) {
    super(`alert not found: ${id}`);
  }
}

/** Any attempt to move a FreezeNotice through a state it cannot legally reach from its current status. */
export class InvalidNoticeTransitionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

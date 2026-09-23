export class AlertNotFoundError extends Error {
  constructor(id: string) {
    super(`alert not found: ${id}`);
  }
}

export class InvalidAlertTransitionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

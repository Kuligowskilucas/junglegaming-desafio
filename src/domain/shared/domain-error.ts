export abstract class DomainError extends Error {
  protected constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export abstract class InvariantViolationError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidOperationError extends InvariantViolationError {
  constructor(message: string) {
    super(message);
  }
}

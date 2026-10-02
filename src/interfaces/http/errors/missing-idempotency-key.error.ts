export class MissingIdempotencyKeyError extends Error {
  constructor() {
    super("The Idempotency-Key header is required");
    this.name = "MissingIdempotencyKeyError";
  }
}

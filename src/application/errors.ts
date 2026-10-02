export abstract class ApplicationError extends Error {
  protected constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(
    readonly playerId: string,
    readonly currency: string,
    readonly existingWalletId: string | undefined,
  ) {
    super("WALLET_ALREADY_EXISTS", `Player ${playerId} already has a ${currency} wallet`);
  }

  withExistingWalletId(existingWalletId: string | undefined): WalletAlreadyExistsError {
    return new WalletAlreadyExistsError(this.playerId, this.currency, existingWalletId);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(readonly walletId: string) {
    super("WALLET_NOT_FOUND", `Wallet ${walletId} does not exist`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  constructor(
    readonly providerId: string,
    readonly idempotencyKey: string,
    readonly existingTransactionId: string,
  ) {
    super(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key ${idempotencyKey} of ${providerId} was already used with a different payload`,
    );
  }
}

export class DuplicateExternalTransactionError extends ApplicationError {
  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly existingTransactionId: string,
  ) {
    super(
      "DUPLICATE_EXTERNAL_TRANSACTION_ID",
      `Transaction ${externalTransactionId} of ${providerId} was already submitted with another idempotency key`,
    );
  }
}

export class DuplicateWagerTransactionError extends ApplicationError {
  constructor(readonly uniqueness: "IDEMPOTENCY_KEY" | "EXTERNAL_TRANSACTION_ID") {
    super("DUPLICATE_WAGER_TRANSACTION", `Another wager transaction already holds this ${uniqueness}`);
  }
}

export class WalletPlayerMismatchError extends ApplicationError {
  constructor(
    readonly walletId: string,
    readonly playerId: string,
  ) {
    super("WALLET_PLAYER_MISMATCH", `Player ${playerId} does not own wallet ${walletId}`);
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  constructor(readonly lookup: string) {
    super("TRANSACTION_NOT_FOUND", `Transaction ${lookup} does not exist`);
  }
}

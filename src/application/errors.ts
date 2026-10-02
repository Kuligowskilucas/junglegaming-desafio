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

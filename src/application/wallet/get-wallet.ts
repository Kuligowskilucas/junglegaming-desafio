import type { Wallet } from "../../domain/wallet/wallet";
import { WalletNotFoundError } from "../errors";
import type { WalletRepository } from "../ports/wallet-repository";

export class GetWallet {
  constructor(private readonly wallets: WalletRepository) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}

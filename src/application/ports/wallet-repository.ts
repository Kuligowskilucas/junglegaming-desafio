import type { Wallet } from "../../domain/wallet/wallet";

export abstract class WalletRepository {
  abstract add(wallet: Wallet): Promise<void>;
  abstract findById(walletId: string): Promise<Wallet | undefined>;
  abstract findByIdForUpdate(walletId: string): Promise<Wallet | undefined>;
  abstract update(wallet: Wallet): Promise<void>;
  abstract findIdByPlayerAndCurrency(playerId: string, currency: string): Promise<string | undefined>;
}

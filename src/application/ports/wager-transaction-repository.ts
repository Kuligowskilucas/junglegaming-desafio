import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

export abstract class WagerTransactionRepository {
  abstract add(transaction: WagerTransaction): Promise<void>;
}

import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { GetWagerTransaction } from "../../../application/wagering/get-wager-transaction";
import { AuthGuard } from "../auth/auth.guard";
import { presentWagerTransaction, type WagerTransactionView } from "./wager-transaction.presenter";
import { externalTransactionIdParam, providerIdParam } from "./wager-transaction.schemas";

@Controller("providers/:providerId/wagering/transactions")
@UseGuards(AuthGuard)
export class ProviderTransactionsController {
  constructor(
    private readonly getWagerTransaction: GetWagerTransaction,
    private readonly pino: PinoLogger,
  ) {}

  @Get(":externalTransactionId")
  async show(
    @Param("providerId", { schema: providerIdParam }) providerId: string,
    @Param("externalTransactionId", { schema: externalTransactionIdParam }) externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    this.pino.assign({ providerId });
    const transaction = await this.getWagerTransaction.byExternalId(providerId, externalTransactionId);
    this.pino.assign({ transactionId: transaction.id, walletId: transaction.walletId });
    return presentWagerTransaction(transaction);
  }
}

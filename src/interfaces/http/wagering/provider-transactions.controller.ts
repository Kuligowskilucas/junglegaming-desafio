import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { GetWagerTransaction } from "../../../application/wagering/get-wager-transaction";
import { AuthGuard } from "../auth/auth.guard";
import { presentWagerTransaction, type WagerTransactionView } from "./wager-transaction.presenter";
import { externalTransactionIdParam, providerIdParam } from "./wager-transaction.schemas";

@Controller("providers/:providerId/wagering/transactions")
@UseGuards(AuthGuard)
export class ProviderTransactionsController {
  constructor(private readonly getWagerTransaction: GetWagerTransaction) {}

  @Get(":externalTransactionId")
  async show(
    @Param("providerId", { schema: providerIdParam }) providerId: string,
    @Param("externalTransactionId", { schema: externalTransactionIdParam }) externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return presentWagerTransaction(await this.getWagerTransaction.byExternalId(providerId, externalTransactionId));
  }
}

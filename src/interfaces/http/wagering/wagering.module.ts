import { Module } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { WageringUseCasesModule } from "../../use-cases/wagering-use-cases.module";
import { ProviderTransactionsController } from "./provider-transactions.controller";
import { WageringController } from "./wagering.controller";

@Module({
  imports: [WageringUseCasesModule],
  controllers: [WageringController, ProviderTransactionsController],
  providers: [AuthGuard],
})
export class WageringModule {}

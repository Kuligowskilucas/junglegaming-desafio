import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { GetWallet } from "../../../application/wallet/get-wallet";
import { ListWalletLedger } from "../../../application/wallet/list-wallet-ledger";
import { OpenWallet } from "../../../application/wallet/open-wallet";
import { ReconcileWallet } from "../../../application/wallet/reconcile-wallet";
import type { WalletReconciliationView } from "../../../domain/wallet/wallet-reconciliation";
import { WageringMetrics } from "../../../infrastructure/observability/wagering-metrics";
import { AuthGuard } from "../auth/auth.guard";
import { CorrelationId } from "../correlation-id.decorator";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import { type LedgerEntryResponse, presentLedgerEntry, presentWallet, type WalletResponse } from "./wallet.presenter";
import { type LedgerQuery, ledgerQuery, type OpenWalletBody, openWalletBody, walletIdParam } from "./wallet.schemas";

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly listWalletLedger: ListWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly metrics: WageringMetrics,
    private readonly pino: PinoLogger,
  ) {}

  @Post()
  @HttpCode(201)
  async open(
    @Body({ schema: openWalletBody }) body: OpenWalletBody,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): Promise<WalletResponse> {
    const wallet = await this.openWallet.execute({ ...body, correlationId });
    this.pino.assign({ walletId: wallet.id });
    if (wallet.balance.isPositive()) {
      this.metrics.openingRecorded();
    }
    response.setHeader("Location", `/wallets/${wallet.id}`);
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async show(@Param("walletId", { schema: walletIdParam }) walletId: string): Promise<WalletResponse> {
    this.pino.assign({ walletId });
    return presentWallet(await this.getWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId", { schema: walletIdParam }) walletId: string,
    @Query({ schema: ledgerQuery }) query: LedgerQuery,
  ): Promise<{ items: LedgerEntryResponse[]; nextCursor: string | null }> {
    this.pino.assign({ walletId });
    const page = await this.listWalletLedger.execute({
      walletId,
      beforeWalletVersion: query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor, walletId),
      limit: query.limit,
    });
    return {
      items: page.entries.map(presentLedgerEntry),
      nextCursor:
        page.nextBeforeWalletVersion === undefined
          ? null
          : encodeLedgerCursor(walletId, page.nextBeforeWalletVersion),
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId", { schema: walletIdParam }) walletId: string): Promise<WalletReconciliationView> {
    this.pino.assign({ walletId });
    const reconciliation = await this.reconcileWallet.execute(walletId);
    this.metrics.reconciliationChecked(reconciliation.consistent);
    if (!reconciliation.consistent) {
      this.logger.error(
        { difference: reconciliation.difference.toJSON(), checkedEntries: reconciliation.checkedEntries },
        "Wallet reconciliation found a divergence",
      );
    }
    return reconciliation.toJSON();
  }
}

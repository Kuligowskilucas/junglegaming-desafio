import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { GetWallet } from "../../../application/wallet/get-wallet";
import { ListWalletLedger } from "../../../application/wallet/list-wallet-ledger";
import { OpenWallet } from "../../../application/wallet/open-wallet";
import { AuthGuard } from "../auth/auth.guard";
import { CorrelationId } from "../correlation-id.decorator";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import { type LedgerEntryResponse, presentLedgerEntry, presentWallet, type WalletResponse } from "./wallet.presenter";
import { type LedgerQuery, ledgerQuery, type OpenWalletBody, openWalletBody, walletIdParam } from "./wallet.schemas";

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly listWalletLedger: ListWalletLedger,
  ) {}

  @Post()
  @HttpCode(201)
  async open(
    @Body({ schema: openWalletBody }) body: OpenWalletBody,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): Promise<WalletResponse> {
    const wallet = await this.openWallet.execute({ ...body, correlationId });
    response.setHeader("Location", `/wallets/${wallet.id}`);
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async show(@Param("walletId", { schema: walletIdParam }) walletId: string): Promise<WalletResponse> {
    return presentWallet(await this.getWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId", { schema: walletIdParam }) walletId: string,
    @Query({ schema: ledgerQuery }) query: LedgerQuery,
  ): Promise<{ items: LedgerEntryResponse[]; nextCursor: string | null }> {
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
}

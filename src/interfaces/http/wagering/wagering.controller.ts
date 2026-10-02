import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { GetWagerTransaction } from "../../../application/wagering/get-wager-transaction";
import { type SubmissionResult, SubmitWagerTransaction } from "../../../application/wagering/submit-wager-transaction";
import { secondsSince, WageringMetrics } from "../../../infrastructure/observability/wagering-metrics";
import { AuthGuard } from "../auth/auth.guard";
import { CorrelationId } from "../correlation-id.decorator";
import { IdempotencyKey } from "./idempotency-key.decorator";
import { presentSubmission, presentWagerTransaction, type WagerTransactionView } from "./wager-transaction.presenter";
import {
  type SubmitWagerTransactionBody,
  submitWagerTransactionBody,
  transactionIdParam,
} from "./wager-transaction.schemas";

interface ReplyControl {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

@Controller("wagering/transactions")
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    private readonly getWagerTransaction: GetWagerTransaction,
    private readonly metrics: WageringMetrics,
    private readonly pino: PinoLogger,
  ) {}

  @Post()
  async submit(
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: submitWagerTransactionBody }) body: SubmitWagerTransactionBody,
    @CorrelationId() correlationId: string,
    @Req() request: { originalUrl: string },
    @Res({ passthrough: true }) response: ReplyControl,
  ): Promise<unknown> {
    this.pino.assign({ providerId: body.providerId, walletId: body.walletId });
    const startedAt = performance.now();
    let result: SubmissionResult;
    try {
      result = await this.submitWagerTransaction.execute({ idempotencyKey, payload: body, correlationId });
    } catch (error) {
      this.metrics.processingObserved("http", "ERROR", secondsSince(startedAt));
      throw error;
    }
    this.metrics.submissionCompleted("http", result, secondsSince(startedAt));
    this.pino.assign({ transactionId: result.transaction.id });
    const reply = presentSubmission(result, { instance: request.originalUrl, correlationId });
    response.status(reply.status);
    response.setHeader("Location", `/wagering/transactions/${result.transaction.id}`);
    if (reply.contentType) {
      response.setHeader("Content-Type", reply.contentType);
    }
    return reply.body;
  }

  @Get(":transactionId")
  async show(
    @Param("transactionId", { schema: transactionIdParam }) transactionId: string,
  ): Promise<WagerTransactionView> {
    this.pino.assign({ transactionId });
    const transaction = await this.getWagerTransaction.byId(transactionId);
    this.pino.assign({ walletId: transaction.walletId, providerId: transaction.providerId });
    return presentWagerTransaction(transaction);
  }
}


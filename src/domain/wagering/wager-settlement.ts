import { InvalidOperationError } from "../shared/domain-error";
import { LedgerDirection } from "../wallet/ledger-direction";
import type { Wallet } from "../wallet/wallet";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { FailureCode, type RejectionCode } from "./failure-code";
import { InvalidTransactionStateError, type WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; code: RejectionCode }
  | { status: WagerTransactionStatus.PendingReference };

export function settleWagerTransaction(input: SettlementInput): SettlementOutcome {
  const { transaction, wallet, reference } = input;
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(transaction.id, transaction.status, "be settled");
  }
  if (wallet.id !== transaction.walletId) {
    throw new InvalidOperationError(`Wallet ${wallet.id} does not belong to transaction ${transaction.id}`);
  }
  if (reference && !transaction.hasReference()) {
    throw new InvalidOperationError(`Transaction ${transaction.id} does not reference ${reference.id}`);
  }
  if (wallet.playerId !== transaction.playerId) {
    return reject(input, FailureCode.WalletPlayerMismatch);
  }
  if (wallet.currency !== transaction.money.currency) {
    return reject(input, FailureCode.CurrencyMismatch);
  }
  if (transaction.hasReference()) {
    const verdict = evaluateReference(input);
    if (verdict) {
      return verdict;
    }
  }
  return applyBalanceEffect(input);
}

function evaluateReference(input: SettlementInput): SettlementOutcome | undefined {
  const { transaction, reference } = input;
  if (!reference) {
    return awaitReference(input, FailureCode.ReferenceNotFound);
  }
  const mismatch = transaction.checkReference(reference);
  if (mismatch) {
    return reject(input, mismatch);
  }
  if (!reference.isTerminal()) {
    return awaitReference(input, FailureCode.ReferenceNotProcessed);
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(input, FailureCode.ReferenceNotProcessed);
  }
  if (transaction.requiresReference() && input.referenceAlreadyReversed) {
    return reject(input, FailureCode.ReferenceAlreadyReversed);
  }
  return undefined;
}

function applyBalanceEffect(input: SettlementInput): SettlementOutcome {
  const { transaction, wallet, reference, at } = input;
  if (!transaction.affectsBalance()) {
    markProcessed(input);
    return { status: WagerTransactionStatus.Processed, entry: undefined };
  }
  const movement = { entryId: input.ledgerEntryId, transactionId: transaction.id, money: transaction.money, at };
  if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Credit) {
    const entry = wallet.credit(movement);
    markProcessed(input);
    return { status: WagerTransactionStatus.Processed, entry };
  }
  if (!wallet.canDebit(transaction.money)) {
    return reject(
      input,
      transaction.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalInsufficientFunds,
    );
  }
  const entry = wallet.debit(movement);
  markProcessed(input);
  return { status: WagerTransactionStatus.Processed, entry };
}

function awaitReference(input: SettlementInput, codeWhenExhausted: RejectionCode): SettlementOutcome {
  if (input.transaction.referenceRetriesExhausted()) {
    return reject(input, codeWhenExhausted);
  }
  input.transaction.markPendingReference(input.at);
  return { status: WagerTransactionStatus.PendingReference };
}

function reject(input: SettlementInput, code: RejectionCode): SettlementOutcome {
  input.transaction.reject(code, { at: input.at, observedBalance: input.wallet.balance });
  return { status: WagerTransactionStatus.Rejected, code };
}

function markProcessed(input: SettlementInput): void {
  input.transaction.markProcessed({
    referenceTransactionId: input.reference?.id,
    at: input.at,
    observedBalance: input.wallet.balance,
  });
}

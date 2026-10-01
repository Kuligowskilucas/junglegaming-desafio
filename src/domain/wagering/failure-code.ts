export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ProcessingRetriesExhausted = "PROCESSING_RETRIES_EXHAUSTED",
}

export type FailedCode = FailureCode.ProcessingRetriesExhausted;

export type RejectionCode = Exclude<FailureCode, FailedCode>;

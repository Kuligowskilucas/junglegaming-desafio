import { DomainError, InvalidOperationError, InvariantViolationError } from "../shared/domain-error";
import type { Money } from "../shared/money";
import { type BackoffPolicy, nextAttemptAt } from "../shared/retry-backoff";
import { LedgerDirection } from "../wallet/ledger-direction";
import { type FailedCode, FailureCode, type RejectionCode } from "./failure-code";
import { hashWagerPayload, type WagerPayload } from "./wager-payload";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

export const internalProviderId = "internal";

export const referenceRetryPolicy: BackoffPolicy & { readonly maxAttempts: number } = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 8,
};

export interface CreateWagerTransactionProps extends WagerPayload {
  id: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  observedBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | undefined;
}

export type InvalidWagerTransactionReason =
  | "BLANK_FIELD"
  | "UNKNOWN_KIND"
  | "INTERNAL_KIND"
  | "RESERVED_PROVIDER"
  | "REFERENCE_REQUIRED"
  | "REFERENCE_NOT_ALLOWED"
  | "SELF_REFERENCE"
  | "NON_POSITIVE_AMOUNT"
  | "NEGATIVE_AMOUNT";

export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly reason: InvalidWagerTransactionReason,
    message: string,
  ) {
    super("INVALID_WAGER_TRANSACTION", message);
  }
}

export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(transactionId: string, status: WagerTransactionStatus, action: string) {
    super(`Transaction ${transactionId} in status ${status} cannot ${action}`);
  }
}

const terminalStatuses: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const submittableKinds: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const reversalKinds: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const acceptedReferenceKinds: Readonly<Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>>> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  private readonly createdAtTime: number;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private nextReferenceAttemptTime: number | undefined;
  private updatedAtTime: number;
  private processedAtTime: number | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAtTime = state.createdAt.getTime();
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this.nextReferenceAttemptTime = state.nextReferenceAttemptAt?.getTime();
    this.updatedAtTime = state.updatedAt.getTime();
    this.processedAtTime = state.processedAt?.getTime();
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertSubmittable(props);
    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: hashWagerPayload(props),
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      observedBalance: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
      createdAt: props.createdAt,
      updatedAt: props.createdAt,
      processedAt: undefined,
    });
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidOperationError(`Opening transaction ${props.id} requires a positive amount`);
    }
    const payload: WagerPayload = {
      providerId: internalProviderId,
      externalTransactionId: `opening:${props.walletId}`,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: `opening:${props.walletId}`,
      gameId: "wallet-opening",
      kind: WagerTransactionKind.Opening,
      money: props.money,
    };
    return new WagerTransaction({
      ...payload,
      id: props.id,
      idempotencyKey: `${internalProviderId}:opening:${props.walletId}`,
      payloadHash: hashWagerPayload(payload),
      referenceExternalTransactionId: undefined,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      observedBalance: props.money,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
      createdAt: props.at,
      updatedAt: props.at,
      processedAt: props.at,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this.nextReferenceAttemptTime === undefined ? undefined : new Date(this.nextReferenceAttemptTime);
  }

  get createdAt(): Date {
    return new Date(this.createdAtTime);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtTime);
  }

  get processedAt(): Date | undefined {
    return this.processedAtTime === undefined ? undefined : new Date(this.processedAtTime);
  }

  markProcessed(props: { referenceTransactionId: string | undefined; at: Date; observedBalance: Money }): void {
    this.assertNotTerminal("be processed");
    if ((props.referenceTransactionId === undefined) !== (this.referenceExternalTransactionId === undefined)) {
      throw new InvalidOperationError(`Transaction ${this.id} must be processed with its reference resolved`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._observedBalance = props.observedBalance;
    this.nextReferenceAttemptTime = undefined;
    this.processedAtTime = props.at.getTime();
    this.updatedAtTime = props.at.getTime();
  }

  markPendingReference(now: Date): void {
    this.assertNotTerminal("wait for its reference");
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidOperationError(`Transaction ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this.nextReferenceAttemptTime = nextAttemptAt(referenceRetryPolicy, this._referenceAttempts, now).getTime();
    this.updatedAtTime = now.getTime();
  }

  reject(code: RejectionCode, props: { at: Date; observedBalance: Money }): void {
    this.assertNotTerminal("be rejected");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = props.observedBalance;
    this.nextReferenceAttemptTime = undefined;
    this.updatedAtTime = props.at.getTime();
  }

  fail(code: FailedCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this.nextReferenceAttemptTime = undefined;
    this.updatedAtTime = at.getTime();
  }

  isTerminal(): boolean {
    return terminalStatuses.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return reversalKinds.has(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  referenceRetriesExhausted(): boolean {
    return this._referenceAttempts >= referenceRetryPolicy.maxAttempts;
  }

  checkReference(reference: WagerTransaction): RejectionCode | undefined {
    if (
      reference.providerId !== this.providerId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId
    ) {
      throw new InvalidOperationError(`Transaction ${reference.id} is not the reference of ${this.id}`);
    }
    if (!acceptedReferenceKinds[this.kind]?.has(reference.kind)) {
      return FailureCode.ReferenceInvalidKind;
    }
    if (
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (this.requiresReference() && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    return undefined;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidOperationError(`LOSS ${this.id} does not move balance`);
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidOperationError(`ROLLBACK ${this.id} needs its reference to choose a direction`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, action);
    }
  }

  private static assertSubmittable(props: CreateWagerTransactionProps): void {
    const requiredFields = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (isBlank(value)) {
        throw new InvalidWagerTransactionError("BLANK_FIELD", `${field} must not be blank`);
      }
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("INTERNAL_KIND", "OPENING is internal and cannot be submitted");
    }
    if (!submittableKinds.has(props.kind)) {
      throw new InvalidWagerTransactionError("UNKNOWN_KIND", `Unknown kind ${String(props.kind)}`);
    }
    if (props.providerId === internalProviderId) {
      throw new InvalidWagerTransactionError("RESERVED_PROVIDER", `Provider id ${internalProviderId} is reserved`);
    }
    WagerTransaction.assertReference(props);
    WagerTransaction.assertAmount(props);
  }

  private static assertReference(props: CreateWagerTransactionProps): void {
    const reference = props.referenceExternalTransactionId;
    if (reference === undefined) {
      if (reversalKinds.has(props.kind)) {
        throw new InvalidWagerTransactionError("REFERENCE_REQUIRED", `${props.kind} requires a reference`);
      }
      return;
    }
    if (isBlank(reference)) {
      throw new InvalidWagerTransactionError("BLANK_FIELD", "referenceExternalTransactionId must not be blank");
    }
    if (acceptedReferenceKinds[props.kind] === undefined) {
      throw new InvalidWagerTransactionError("REFERENCE_NOT_ALLOWED", `${props.kind} cannot carry a reference`);
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("SELF_REFERENCE", "A transaction cannot reference itself");
    }
  }

  private static assertAmount(props: CreateWagerTransactionProps): void {
    if (props.kind === WagerTransactionKind.Loss) {
      if (props.money.isNegative()) {
        throw new InvalidWagerTransactionError("NEGATIVE_AMOUNT", "LOSS amount must not be negative");
      }
      return;
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError("NON_POSITIVE_AMOUNT", `${props.kind} amount must be positive`);
    }
  }
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

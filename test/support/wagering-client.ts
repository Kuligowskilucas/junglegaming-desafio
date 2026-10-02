export interface WalletHandle {
  id: string;
  playerId: string;
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface SubmissionResponse {
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | null;
}

export function wager(
  wallet: WalletHandle,
  kind: string,
  amount: string,
  overrides: Partial<WagerPayload> = {},
): WagerPayload {
  return {
    providerId: "provider-a",
    externalTransactionId: `${kind.toLowerCase()}-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...overrides,
  };
}

export function keyOf(payload: WagerPayload): string {
  return `${payload.providerId}:${payload.externalTransactionId}`;
}

export class WageringClient {
  retriedAfter503 = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly options: { retryOn503: boolean; maxAttempts: number } = { retryOn503: false, maxAttempts: 1 },
  ) {}

  static retrying(baseUrl: string): WageringClient {
    return new WageringClient(baseUrl, { retryOn503: true, maxAttempts: 30 });
  }

  async openWallet(amount: string, currency = "BRL"): Promise<WalletHandle> {
    const playerId = Bun.randomUUIDv7();
    const response = await fetch(`${this.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
    });
    if (response.status !== 201) {
      throw new Error(`could not open wallet: ${response.status} ${await response.text()}`);
    }
    return { id: ((await response.json()) as { id: string }).id, playerId };
  }

  async submit(
    payload: unknown,
    idempotencyKey: string | undefined,
    headers: Record<string, string> = {},
  ): Promise<SubmissionResponse> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${this.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
          ...headers,
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as Record<string, unknown>;
      const retryAfter = response.headers.get("retry-after");
      if (response.status !== 503 || !this.options.retryOn503 || attempt >= this.options.maxAttempts) {
        return { status: response.status, body, retryAfter };
      }
      this.retriedAfter503 += 1;
      await Bun.sleep(Number(retryAfter ?? "1") * 1_000);
    }
  }

  submitWager(payload: WagerPayload, headers: Record<string, string> = {}): Promise<SubmissionResponse> {
    return this.submit(payload, keyOf(payload), headers);
  }

  async transaction(providerId: string, externalTransactionId: string): Promise<Record<string, unknown> | undefined> {
    const response = await fetch(`${this.baseUrl}/providers/${providerId}/wagering/transactions/${externalTransactionId}`);
    return response.status === 200 ? ((await response.json()) as Record<string, unknown>) : undefined;
  }

  async balanceOf(walletId: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/wallets/${walletId}`);
    return ((await response.json()) as { balance: { amount: string } }).balance.amount;
  }
}

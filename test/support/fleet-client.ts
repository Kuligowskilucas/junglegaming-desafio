import type { AppProcess } from "./app-process";
import { keyOf, type SubmissionResponse, type WagerPayload, type WalletHandle } from "./wagering-client";

const maxAttempts = 60;
const pauseBetweenAttemptsMs = 200;

export class FleetClient {
  private next = 0;
  retries = 0;

  constructor(private readonly fleet: () => AppProcess[]) {}

  async submitWager(payload: WagerPayload, headers: Record<string, string> = {}): Promise<SubmissionResponse> {
    for (let attempt = 1; ; attempt += 1) {
      const target = this.pick();
      try {
        const response = await fetch(`${target.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": keyOf(payload), ...headers },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 503) {
          return { status: response.status, body: (await response.json()) as Record<string, unknown>, retryAfter: null };
        }
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
      }
      if (attempt >= maxAttempts) {
        throw new Error(`${payload.externalTransactionId} did not get a final answer after ${maxAttempts} attempts`);
      }
      this.retries += 1;
      await Bun.sleep(pauseBetweenAttemptsMs);
    }
  }

  async openWallet(amount: string, currency = "BRL"): Promise<WalletHandle> {
    const playerId = Bun.randomUUIDv7();
    const { status, body } = await this.post<{ id?: string; walletId?: string }>("/wallets", {
      playerId,
      initialBalance: { amount, currency },
    });
    const walletId = status === 201 ? body.id : status === 409 ? body.walletId : undefined;
    if (walletId === undefined) {
      throw new Error(`could not open wallet: ${status} ${JSON.stringify(body)}`);
    }
    return { id: walletId, playerId };
  }

  async get<T>(path: string): Promise<{ status: number; body: T }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetch(`${this.pick().baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
        return { status: response.status, body: (await response.json()) as T };
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
        await Bun.sleep(pauseBetweenAttemptsMs);
      }
    }
  }

  async post<T>(path: string, body: unknown = undefined): Promise<{ status: number; body: T }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetch(`${this.pick().baseUrl}${path}`, {
          method: "POST",
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 503) {
          return { status: response.status, body: (await response.json()) as T };
        }
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
      }
      await Bun.sleep(pauseBetweenAttemptsMs);
    }
  }

  private pick(): AppProcess {
    const alive = this.fleet().filter((app) => app.isRunning);
    if (alive.length === 0) {
      throw new Error("no running instance to send the request to");
    }
    this.next = (this.next + 1) % alive.length;
    return alive[this.next]!;
  }
}

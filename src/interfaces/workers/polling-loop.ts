import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@nestjs/common";

export type CycleResult = "BUSY" | "IDLE";

export interface PollingLoopSettings {
  idleDelayMs: number;
  shutdownGraceMs: number;
}

export class PollingLoop {
  private stopping = false;
  private running: Promise<void> | undefined;
  private idle: AbortController | undefined;

  constructor(
    private readonly name: string,
    private readonly settings: PollingLoopSettings,
    private readonly logger: Logger,
    private readonly cycle: () => Promise<CycleResult>,
  ) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.stopping = false;
    this.running = this.loop();
    this.logger.log({ idleDelayMs: this.settings.idleDelayMs }, `${this.name} started`);
  }

  async stop(): Promise<void> {
    const running = this.running;
    if (!running) {
      return;
    }
    this.stopping = true;
    this.idle?.abort();
    const drained = await Promise.race([
      running.then(() => true),
      delay(this.settings.shutdownGraceMs).then(() => false),
    ]);
    if (!drained) {
      this.logger.warn(
        { graceMs: this.settings.shutdownGraceMs },
        `${this.name} grace elapsed with a cycle in progress; its transaction rolls back when the connection closes`,
      );
    }
    this.running = undefined;
    this.logger.log(`${this.name} stopped`);
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      if ((await this.runCycle()) === "IDLE") {
        await this.pause();
      }
    }
  }

  private async runCycle(): Promise<CycleResult> {
    try {
      return await this.cycle();
    } catch (error) {
      this.logger.error({ err: error }, `${this.name} cycle failed`);
      return "IDLE";
    }
  }

  private async pause(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.idle = new AbortController();
    try {
      await delay(this.settings.idleDelayMs, undefined, { signal: this.idle.signal });
    } catch {
      return;
    } finally {
      this.idle = undefined;
    }
  }
}

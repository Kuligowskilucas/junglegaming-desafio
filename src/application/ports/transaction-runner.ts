export abstract class TransactionRunner {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
  abstract readSnapshot<T>(work: () => Promise<T>): Promise<T>;
}

import { PinoLogger } from "nestjs-pino";
import type { DestinationStream, Level } from "pino";

export type LogLine = Record<string, unknown>;

const activeCaptures = new Set<LogCapture>();

export const testLogSink: DestinationStream = {
  write(line: string): void {
    process.stdout.write(line);
    for (const capture of activeCaptures) {
      capture.write(line);
    }
  },
};

export class LogCapture {
  readonly raw: string[] = [];
  private previousLevel: string | undefined;

  start(level: Level = "info"): this {
    activeCaptures.add(this);
    this.previousLevel = PinoLogger.root.level;
    PinoLogger.root.level = level;
    return this;
  }

  stop(): void {
    activeCaptures.delete(this);
    if (this.previousLevel !== undefined) {
      PinoLogger.root.level = this.previousLevel;
    }
  }

  write(line: string): void {
    this.raw.push(line);
  }

  get lines(): LogLine[] {
    return this.raw
      .flatMap((line) => line.split("\n").filter((part) => part.trim().length > 0))
      .map((part) => JSON.parse(part) as LogLine);
  }

  duplicatedKeys(): string[] {
    return this.raw
      .flatMap((line) => line.split("\n").filter((part) => part.trim().length > 0))
      .flatMap(duplicateTopLevelKeys);
  }

  withMessage(message: string): LogLine[] {
    return this.lines.filter((line) => line.message === message);
  }

  clear(): void {
    this.raw.length = 0;
  }
}

function duplicateTopLevelKeys(json: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < json.length) {
    const char = json[index]!;
    if (char === '"') {
      let end = index + 1;
      while (json[end] !== '"') {
        end += json[end] === "\\" ? 2 : 1;
      }
      if (depth === 1 && json.slice(end + 1).trimStart().startsWith(":")) {
        keys.push(JSON.parse(json.slice(index, end + 1)) as string);
      }
      index = end + 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    index += 1;
  }
  return keys.filter((key, position) => keys.indexOf(key) !== position);
}

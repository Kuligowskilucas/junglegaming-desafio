export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export class MetricsSnapshot {
  constructor(
    readonly samples: MetricSample[],
    readonly text: string,
  ) {}

  value(name: string, labels: Record<string, string> = {}): number | undefined {
    const sample = this.samples.find(
      (candidate) =>
        candidate.name === name &&
        Object.entries(labels).every(([label, expected]) => candidate.labels[label] === expected) &&
        Object.keys(candidate.labels).length === Object.keys(labels).length,
    );
    return sample?.value;
  }

  sum(name: string, labels: Record<string, string> = {}): number {
    return this.samples
      .filter(
        (candidate) =>
          candidate.name === name &&
          Object.entries(labels).every(([label, expected]) => candidate.labels[label] === expected),
      )
      .reduce((total, sample) => total + sample.value, 0);
  }

  increaseSince(before: MetricsSnapshot, name: string, labels: Record<string, string> = {}): number {
    return this.sum(name, labels) - before.sum(name, labels);
  }
}

const sampleLine = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/;
const labelPair = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parseMetrics(text: string): MetricsSnapshot {
  const samples = text.split("\n").flatMap((line) => {
    const match = sampleLine.exec(line);
    if (!match || line.startsWith("#")) {
      return [];
    }
    const [, name, labelText, value] = match;
    const labels = Object.fromEntries([...(labelText ?? "").matchAll(labelPair)].map(([, label, text]) => [label, text]));
    return [{ name: name!, labels, value: Number(value) }];
  });
  return new MetricsSnapshot(samples, text);
}

export async function scrapeMetrics(baseUrl: string): Promise<MetricsSnapshot> {
  const response = await fetch(`${baseUrl}/metrics`);
  if (response.status !== 200) {
    throw new Error(`metrics scrape failed: ${response.status}`);
  }
  return parseMetrics(await response.text());
}

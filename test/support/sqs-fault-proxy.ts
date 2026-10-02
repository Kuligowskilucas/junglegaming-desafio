import type { Server } from "bun";
import { testConfig } from "./database";

type SqsOperation = "DeleteMessage" | "SendMessage";
type HoldMode = "BEFORE_FORWARDING" | "AFTER_FORWARDING";

interface HoldRule {
  operation: SqsOperation;
  mode: HoldMode;
  matches: (body: Record<string, unknown>) => boolean;
  onHeld: (body: Record<string, unknown>) => void;
}

const responseHeadersToDrop = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

export class SqsFaultProxy {
  private readonly rules: HoldRule[] = [];
  private readonly releases = new Set<() => void>();
  private readonly server: Server<undefined>;

  constructor(private readonly target = testConfig().sqs.endpoint ?? "http://localhost:4566") {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  holdBeforeForwarding(
    operation: SqsOperation,
    matches: (body: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> {
    return this.arm(operation, "BEFORE_FORWARDING", matches);
  }

  holdAfterForwarding(
    operation: SqsOperation,
    matches: (body: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> {
    return this.arm(operation, "AFTER_FORWARDING", matches);
  }

  stop(): void {
    for (const release of this.releases) {
      release();
    }
    this.server.stop(true);
  }

  private arm(
    operation: SqsOperation,
    mode: HoldMode,
    matches: (body: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    return new Promise((onHeld) => this.rules.push({ operation, mode, matches, onHeld }));
  }

  private async handle(request: Request): Promise<Response> {
    const bodyBytes = await request.arrayBuffer();
    const operation = request.headers.get("x-amz-target")?.replace("AmazonSQS.", "");
    const body = parseBody(bodyBytes);
    const ruleIndex = this.rules.findIndex((rule) => rule.operation === operation && rule.matches(body));
    const rule = ruleIndex === -1 ? undefined : this.rules.splice(ruleIndex, 1)[0];
    if (rule?.mode === "BEFORE_FORWARDING") {
      rule.onHeld(body);
      return this.holdForever();
    }
    const forwarded = await this.forward(request, bodyBytes);
    if (rule?.mode === "AFTER_FORWARDING") {
      rule.onHeld(body);
      return this.holdForever();
    }
    return forwarded;
  }

  private async forward(request: Request, body: ArrayBuffer): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetch(`${this.target}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    });
    const responseHeaders = new Headers();
    response.headers.forEach((value, name) => {
      if (!responseHeadersToDrop.has(name.toLowerCase())) {
        responseHeaders.set(name, value);
      }
    });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: responseHeaders });
  }

  private holdForever(): Promise<Response> {
    return new Promise((resolve) => {
      const release = () => resolve(new Response("released by the test proxy", { status: 503 }));
      this.releases.add(release);
    });
  }
}

function parseBody(bytes: ArrayBuffer): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

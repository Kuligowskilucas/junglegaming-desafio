export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  retryable: boolean;
  correlationId?: string | undefined;
  [extension: string]: unknown;
}

export interface ProblemDescription {
  status: number;
  code: string;
  title: string;
  detail: string;
  retryable?: boolean;
  extensions?: Record<string, unknown>;
}

export function problemDetails(
  description: ProblemDescription,
  request: { instance: string; correlationId: string | undefined },
): ProblemDetails {
  return {
    type: `urn:wagering:problem:${description.code.toLowerCase().replaceAll("_", "-")}`,
    title: description.title,
    status: description.status,
    detail: description.detail,
    instance: request.instance,
    code: description.code,
    retryable: description.retryable ?? false,
    correlationId: request.correlationId,
    ...description.extensions,
  };
}

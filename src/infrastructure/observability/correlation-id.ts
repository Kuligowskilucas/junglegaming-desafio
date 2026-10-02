const acceptedCorrelationId = /^[A-Za-z0-9._:-]{1,128}$/;

export function isAcceptedCorrelationId(value: unknown): value is string {
  return typeof value === "string" && acceptedCorrelationId.test(value);
}

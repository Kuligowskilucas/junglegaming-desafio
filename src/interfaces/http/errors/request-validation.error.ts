export interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RequestValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    super("Request validation failed");
    this.name = "RequestValidationError";
    this.issues = issues.map((issue) => ({
      path: (issue.path ?? [])
        .map((segment) => String(typeof segment === "object" ? segment.key : segment))
        .join("."),
      message: issue.message,
    }));
  }
}

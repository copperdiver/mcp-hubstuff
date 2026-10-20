export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class HubstaffApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message = `Hubstaff API request failed with HTTP ${status}`,
  ) {
    super(message);
    this.name = "HubstaffApiError";
  }
}

// Only the HTTP boundary creates these errors. A TypeError elsewhere is internal.
export class HubstaffRequestError extends Error {
  constructor(
    public readonly kind: "network" | "timeout" | "response",
    cause: unknown,
    public readonly status?: number,
  ) {
    super(`Hubstaff ${kind} failure`, { cause });
    this.name = "HubstaffRequestError";
  }
}

export function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code ?? "")) {
    return true;
  }
  const cause = error.cause;
  return cause instanceof Error && (
    cause.name === "TimeoutError" ||
    ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]
      .includes((cause as NodeJS.ErrnoException).code ?? "")
  );
}

export function classifyError(error: unknown) {
  if (error instanceof ToolInputError) return { error_category: "validation", error_kind: "validation" } as const;
  if (error instanceof HubstaffApiError) {
    return { error_category: "upstream", error_kind: "http", upstream_status: error.status } as const;
  }
  if (error instanceof HubstaffRequestError) {
    return { error_category: "upstream", error_kind: error.kind, upstream_status: error.status } as const;
  }
  return { error_category: "internal", error_kind: "internal" } as const;
}

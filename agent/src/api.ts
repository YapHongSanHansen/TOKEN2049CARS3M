/** Plain JSON calls to carsem-api (the unpaid ones; paid calls go through x402Client). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); }
}

export async function api<T = any>(baseUrl: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
  if (!response.ok) {
    const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`;
    throw new ApiError(response.status, `${init.method ?? "GET"} ${path}: ${message}`, body);
  }
  return body as T;
}

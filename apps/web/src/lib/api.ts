import type { ApiError } from "@redline/api-types";

export class ApiFailure extends Error {
  constructor(public status: number, public body: ApiError | null) {
    super(body?.error.message ?? `Request failed (${status})`);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiFailure(res.status, body as ApiError | null);
  return body as T;
}

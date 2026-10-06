import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, bigints as strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

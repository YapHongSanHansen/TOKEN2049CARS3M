import { randomBytes } from "node:crypto";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

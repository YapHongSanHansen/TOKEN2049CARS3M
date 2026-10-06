/**
 * KYC — a mock for the demo, clearly labelled as such. It enforces the rule
 * that matters: one identity document = one CARSEM account = one platform
 * wallet. Only a hash of the document is kept. A real provider (e.g. SumSub)
 * would replace mockKyc and return the same KycOutcome.
 */
import { sha256Hex } from "@carsem/shared";
import { HttpError } from "./errors.js";

export type KycOutcome = { status: "verified"; subjectHash: string; ref: string; firstName?: string } | { status: "pending" | "rejected"; ref?: string; detail?: string };

export function mockKyc(input: { fullName?: unknown; documentNumber?: unknown; country?: unknown }): KycOutcome {
  const fullName = String(input.fullName ?? "").trim();
  const documentNumber = String(input.documentNumber ?? "").replace(/[\s-]/g, "").toUpperCase();
  const country = String(input.country ?? "").trim().toUpperCase();
  if (fullName.length < 2 || documentNumber.length < 5 || !/^[A-Z]{2,3}$/.test(country)) {
    throw new HttpError(400, "KYC needs fullName, documentNumber (5+ characters) and a 2-3 letter country code");
  }
  return { status: "verified", subjectHash: sha256Hex(`kyc-subject:${country}:${documentNumber}`), ref: `mock:${documentNumber.slice(-4)}`, firstName: fullName.split(/s+/)[0] };
}

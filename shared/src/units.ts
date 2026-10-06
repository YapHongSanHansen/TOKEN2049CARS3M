/** x402 network id. Both chain modes speak it so the official Cardano scheme accepts every offer. */
export const NETWORK = "cardano:preprod";
export const LOVELACE = "lovelace";
export const USDM_DECIMALS = 6;
export const ADA_DECIMALS = 6;
/** Same shape check the x402 Cardano scheme applies to `payTo`. */
export const CARDANO_ADDRESS_REGEX = /^(addr1|addr_test1)[0-9a-z]+$/;

/** "5.10" -> 5100000n. Rejects more precision than the asset supports. */
export function toUnits(amount: string | number, decimals = USDM_DECIMALS): bigint {
  const text = typeof amount === "number" ? amount.toFixed(decimals) : amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Not a non-negative decimal amount: ${amount}`);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) throw new Error(`${amount} has more than ${decimals} decimals`);
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** 5100000n -> "5.1" */
export function fromUnits(units: bigint | string, decimals = USDM_DECIMALS): string {
  const value = BigInt(units);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const base = 10n ** BigInt(decimals);
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${abs / base}${fraction ? `.${fraction}` : ""}`;
}

/** Asset ids as the x402 Cardano scheme writes them: `lovelace` or `policyId.assetNameHex`. */
export function blockfrostUnit(asset: string): string {
  return asset === LOVELACE ? LOVELACE : asset.replace(".", "");
}
